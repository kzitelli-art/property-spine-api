#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   READ-ONLY · NO DATABASE · WHAT REFERENCES `properties`, AND HOW HARD

   Slice 1 of the property identity inventory (CC_BUILD1). It derives,
   from migration SOURCE alone, every foreign key that points at
   `properties` and what each one does when the referenced row is
   deleted.

       node tools/identity/property_dependency_graph.js
       node tools/identity/property_dependency_graph.js --json

   ── ⛔ WHAT THIS IS NOT ──────────────────────────────────────────────
   THIS IS A CATALOG. A CATALOG IS A DESCRIPTION OF THE WORLD, NOT THE
   WORLD.

   That sentence is not a disclaimer, it is this repo's own recorded
   defect. `docs/IDENTITY_HYGIENE_REGISTER.md` H-1: an inventory built on
   information_schema foreign-key views reported "67 tables checked, 0
   rows attached" and that was published as proof of inertness. It was
   wrong. The row it missed was found by asking the question production
   asks, against the rows production reads.

   This tool is a further step REMOVED from the world than that one was.
   It reads declared migration text, not even the live catalog. So:

     it says     which FKs are DECLARED, and what they would do
     it CANNOT say  whether any row exists behind any of them
     it CANNOT say  what a delete would actually destroy
     it CANNOT say  that the deployed database matches these files

   Counting rows is a separate, deliberate act against real data — that
   is Slice 2's census script, and it is generated here and run
   elsewhere by a human.

   ── WHY MIGRATION SOURCE AND NOT information_schema ─────────────────
   Deliberate, and it is the point rather than a limitation. Reading the
   live catalog requires a database connection, and the only database
   worth asking is production. This build is read-only and has no
   production access, so a source-derived graph is what can be produced
   honestly. It also carries something the catalog does not: the
   MIGRATION AND LINE where each edge was declared, so every edge is
   traceable to the change that introduced it.

   The two disagreeing is itself a finding worth having, and Slice 2's
   census is what would surface it.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

/* ── Comment stripping ───────────────────────────────────────────────
   CLAUDE.md: "Strip comments before scanning. A mention is not a
   guard." A commented-out FK must not become an edge, and prose in a
   migration header routinely contains the word `properties`.
   Line numbers are preserved by replacing comment bodies with spaces
   rather than deleting them.                                          */
function stripComments(sql) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line_comment | block_comment | single | dollar
  let dollarTag = "";
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (state === "code") {
      if (two === "--") { state = "line_comment"; out += "  "; i += 2; continue; }
      if (two === "/*") { state = "block_comment"; out += "  "; i += 2; continue; }
      if (sql[i] === "'") { state = "single"; out += sql[i]; i += 1; continue; }
      const dollar = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (dollar) { state = "dollar"; dollarTag = dollar[0]; out += " ".repeat(dollar[0].length); i += dollar[0].length; continue; }
      out += sql[i]; i += 1; continue;
    }
    if (state === "line_comment") {
      if (sql[i] === "\n") { state = "code"; out += "\n"; i += 1; continue; }
      out += " "; i += 1; continue;
    }
    if (state === "block_comment") {
      if (two === "*/") { state = "code"; out += "  "; i += 2; continue; }
      out += sql[i] === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (state === "single") {
      if (two === "''") { out += "  "; i += 2; continue; }
      if (sql[i] === "'") { state = "code"; out += sql[i]; i += 1; continue; }
      out += sql[i] === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (state === "dollar") {
      if (sql.slice(i, i + dollarTag.length) === dollarTag) {
        state = "code"; out += " ".repeat(dollarTag.length); i += dollarTag.length; continue;
      }
      out += sql[i] === "\n" ? "\n" : " "; i += 1; continue;
    }
  }
  return out;
}

const lineOf = (sql, index) => sql.slice(0, index).split("\n").length;
const norm = (s) => (s || "").trim().replace(/"/g, "").toLowerCase();

/* ON DELETE action, and what it MEANS for a delete of the parent row. */
const ACTIONS = {
  cascade:     { key: "CASCADE",   effect: "DESTROYS", note: "child rows are deleted with the parent" },
  "set null":  { key: "SET NULL",  effect: "ORPHANS",  note: "child rows survive, pointer silently nulled" },
  "set default": { key: "SET DEFAULT", effect: "ORPHANS", note: "child rows survive, pointer reset to default" },
  restrict:    { key: "RESTRICT",  effect: "BLOCKS",   note: "delete refused immediately if any child row exists" },
  "no action": { key: "NO ACTION", effect: "BLOCKS",   note: "delete refused at constraint-check time if any child row exists" },
};

function readAction(tail) {
  const m = /^\s*on\s+delete\s+(cascade|restrict|no\s+action|set\s+null|set\s+default)/i.exec(tail);
  if (!m) return ACTIONS["no action"]; // PostgreSQL default when the clause is absent
  return ACTIONS[m[1].toLowerCase().replace(/\s+/g, " ")];
}

/* ── Statement splitting ─────────────────────────────────────────────
   Split on semicolons at paren-depth 0 so a `create table` body stays
   one statement.                                                      */
function statements(sql) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) { out.push({ text: sql.slice(start, i), offset: start }); start = i + 1; }
  }
  if (sql.slice(start).trim()) out.push({ text: sql.slice(start), offset: start });
  return out;
}

/* Split a create-table body on top-level commas. */
function topLevelParts(body) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { parts.push({ text: body.slice(start, i), offset: start }); start = i + 1; }
  }
  if (body.slice(start).trim()) parts.push({ text: body.slice(start), offset: start });
  return parts;
}

const REF_PROPERTIES = /references\s+(?:public\s*\.\s*)?"?properties"?\s*(?:\(\s*"?([a-z_]+)"?\s*\))?/i;

function parseMigration(file, rawSql, edges, drops, unparsed) {
  const sql = stripComments(rawSql);
  for (const st of statements(sql)) {
    const text = st.text;

    /* DROP TABLE — removes every edge that table declared. */
    const dropTable = /^\s*drop\s+table\s+(?:if\s+exists\s+)?([a-z0-9_.," ]+)/i.exec(text);
    if (dropTable) {
      for (const t of dropTable[1].split(",")) {
        const name = norm(t).replace(/^public\./, "").replace(/\s+cascade$/, "").replace(/\s+restrict$/, "").trim();
        if (name) drops.push({ kind: "drop_table", table: name, file, line: lineOf(sql, st.offset) });
      }
      continue;
    }

    /* CREATE TABLE — inline column refs and table-level FK constraints. */
    const createTable = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\s*\.\s*)?"?([a-z0-9_]+)"?\s*\(/i.exec(text);
    if (createTable) {
      const table = norm(createTable[1]);
      const bodyStart = text.indexOf("(", createTable.index);
      const body = text.slice(bodyStart + 1, text.lastIndexOf(")"));
      const bodyOffset = st.offset + bodyStart + 1;
      for (const part of topLevelParts(body)) {
        const ref = REF_PROPERTIES.exec(part.text);
        if (!ref) continue;
        const action = readAction(part.text.slice(ref.index + ref[0].length));
        const line = lineOf(sql, bodyOffset + part.offset);

        // table-level: [constraint x] foreign key (cols) references properties
        const tableLevel = /(?:constraint\s+"?([a-z0-9_]+)"?\s+)?foreign\s+key\s*\(\s*([^)]+)\)/i.exec(part.text);
        if (tableLevel) {
          for (const col of tableLevel[2].split(",")) {
            edges.push({ table, column: norm(col), constraint: norm(tableLevel[1]) || null,
                         action: action.key, effect: action.effect, notNull: /not\s+null/i.test(part.text),
                         declaredIn: file, line, form: "table_constraint" });
          }
          continue;
        }
        // column-level: <col> <type> ... references properties
        const colDef = /^\s*"?([a-z0-9_]+)"?\s+/i.exec(part.text);
        if (colDef) {
          edges.push({ table, column: norm(colDef[1]), constraint: null,
                       action: action.key, effect: action.effect, notNull: /not\s+null/i.test(part.text),
                       declaredIn: file, line, form: "column_inline" });
          continue;
        }
        unparsed.push({ file, line, text: part.text.trim().slice(0, 160) });
      }
      continue;
    }

    /* ALTER TABLE ... ADD [CONSTRAINT x] FOREIGN KEY (cols) REFERENCES properties */
    const alter = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\s*\.\s*)?"?([a-z0-9_]+)"?/i.exec(text);
    if (alter && REF_PROPERTIES.test(text)) {
      const table = norm(alter[1]);
      const ref = REF_PROPERTIES.exec(text);
      const action = readAction(text.slice(ref.index + ref[0].length));
      const line = lineOf(sql, st.offset);
      const fk = /(?:constraint\s+"?([a-z0-9_]+)"?\s+)?foreign\s+key\s*\(\s*([^)]+)\)/i.exec(text);
      if (fk) {
        for (const col of fk[2].split(",")) {
          edges.push({ table, column: norm(col), constraint: norm(fk[1]) || null,
                       action: action.key, effect: action.effect, notNull: false,
                       declaredIn: file, line, form: "alter_add_constraint" });
        }
      } else {
        // ALTER TABLE ... ADD COLUMN x uuid references properties(id) ...
        const addCol = /add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+[a-z]/i.exec(text);
        if (addCol) {
          edges.push({ table, column: norm(addCol[1]), constraint: null,
                       action: action.key, effect: action.effect, notNull: /not\s+null/i.test(text),
                       declaredIn: file, line, form: "alter_add_column" });
        } else {
          unparsed.push({ file, line, text: text.trim().slice(0, 160) });
        }
      }
      continue;
    }

    /* Any other statement that mentions a reference to properties is a
       parser gap and must be reported, never silently dropped. */
    if (REF_PROPERTIES.test(text)) {
      unparsed.push({ file, line: lineOf(sql, st.offset), text: text.trim().slice(0, 160) });
    }
  }
}

/* ── The OTHER graph: what a REBIND would collide with ───────────────
   ON DELETE actions answer "what if the row is deleted." The property
   identity question is not a delete — it is a MIGRATION: repoint one
   property's children onto another canonical row. A delete-graph says
   nothing about that.

   What refuses a repoint is UNIQUENESS. If two properties each hold a
   row with the same business key, moving one onto the other violates a
   unique constraint and the merge fails part-way through.

   Two classes, and they behave oppositely:

     ANCHOR     the constraint includes the table's own `id`. It exists
                so a child can FK to (id, property_id) and be forced to
                agree about its property. `id` is already unique, so
                such a constraint CANNOT collide on a merge.
     COLLIDABLE property_id + a business key. THESE are the ones that
                refuse a repoint when both properties hold the same key. */
/* Read a balanced parenthesised group starting at `open`. Naive
   /\(([^)]*)\)/ truncates expression columns like `coalesce(a, b)` and
   `lower(trim(x))`, which silently corrupts the column list. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") { depth--; if (depth === 0) return { body: text.slice(open + 1, i), end: i }; }
  }
  return null;
}

/* Split on commas at depth 0 so `coalesce(a, b)` stays one column. */
function splitCols(body) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  if (body.slice(start).trim()) out.push(body.slice(start));
  return out.map((s) => s.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
}

/* The WHERE predicate of a partial index is read from text with string
   literals INTACT. Comment-stripping blanks quoted values, which turned
   `where status = 'current'` into `where status =` — a predicate that
   reads as if it were unconditional. Comments are still removed. */
function stripCommentsKeepStrings(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function findUniqueGroups(text, offsetToLine) {
  const found = [];
  const re = /(?:constraint\s+"?([a-z0-9_]+)"?\s+)?\bunique\s*\(/gi;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf("(", m.index + m[0].length - 1);
    const grp = balanced(text, open);
    if (!grp) continue;
    const cols = splitCols(grp.body);
    if (!cols.some((c) => /\bproperty_id\b/.test(c))) continue;
    found.push({ name: norm(m[1]) || null, columns: cols, index: m.index });
  }
  return found;
}

function parseUniques(file, rawSql, uniques) {
  const sql = stripComments(rawSql);
  const withStrings = stripCommentsKeepStrings(rawSql);

  for (const st of statements(sql)) {
    const createTable = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\s*\.\s*)?"?([a-z0-9_]+)"?\s*\(/i.exec(st.text);
    const alter = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\s*\.\s*)?"?([a-z0-9_]+)"?/i.exec(st.text);
    const table = createTable ? norm(createTable[1]) : alter ? norm(alter[1]) : null;
    if (!table) continue;
    for (const g of findUniqueGroups(st.text)) {
      uniques.push({ table, name: g.name, columns: g.columns, partial: null,
                     declaredIn: file, line: lineOf(sql, st.offset + g.index) });
    }
  }

  /* Standalone `create unique index`, including inside DO $$ blocks and
     EXECUTE strings — so this scans text with literals preserved. */
  const idxRe = /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+"?([a-z0-9_]+)"?\s*\(/gi;
  let mi;
  while ((mi = idxRe.exec(withStrings))) {
    const open = withStrings.indexOf("(", mi.index + mi[0].length - 1);
    const grp = balanced(withStrings, open);
    if (!grp) continue;
    const cols = splitCols(grp.body);
    if (!cols.some((c) => /\bproperty_id\b/.test(c))) continue;
    const tail = withStrings.slice(grp.end + 1, grp.end + 400);
    const where = /^\s*where\s+([^;]+)/i.exec(tail);
    // Inside `execute '…'` the literals are doubled ('' for '); collapse
    // them, then drop the trailing quote that closes the EXECUTE string.
    let partial = where ? where[1].trim().replace(/\s+/g, " ").replace(/''/g, "'") : null;
    if (partial) {
      const quotes = (partial.match(/'/g) || []).length;
      if (quotes % 2 === 1) partial = partial.replace(/'\s*$/, "");
    }
    uniques.push({ table: norm(mi[2]), name: norm(mi[1]), columns: cols, partial,
                   declaredIn: file, line: lineOf(withStrings, mi.index) });
  }
}

function classifyUnique(u) {
  const business = u.columns.filter((c) => !/^property_id$/.test(c));
  // A constraint carrying the row's own surrogate key cannot collide:
  // `id` is unique by itself, so no two rows can share it post-merge.
  if (u.columns.includes("id")) return { klass: "ANCHOR", business };
  // property_id ALONE (optionally partial) = at most one row per property.
  // Merge two populated properties and the collision is GUARANTEED, not
  // conditional on a shared key. This is the strongest class, and the
  // naive reading renders it as an empty key list, which looks like the
  // weakest.
  if (business.length === 0) return { klass: "SINGLETON", business };
  return { klass: "COLLIDABLE", business };
}

function build() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const edges = [], drops = [], unparsed = [], uniques = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    parseMigration(f, raw, edges, drops, unparsed);
    parseUniques(f, raw, uniques);
  }
  const droppedTables = new Set(drops.filter((d) => d.kind === "drop_table").map((d) => d.table));
  const live = edges.filter((e) => !droppedTables.has(e.table));
  const dropped = edges.filter((e) => droppedTables.has(e.table));
  const liveUniques = uniques
    .filter((u) => !droppedTables.has(u.table))
    .map((u) => ({ ...u, ...classifyUnique(u) }));
  return { files, edges: live, droppedEdges: dropped, droppedTables: [...droppedTables], unparsed, uniques: liveUniques };
}

function report(g) {
  const byEffect = { DESTROYS: [], BLOCKS: [], ORPHANS: [] };
  for (const e of g.edges) byEffect[e.effect].push(e);
  const byAction = {};
  for (const e of g.edges) byAction[e.action] = (byAction[e.action] || 0) + 1;

  const L = [];
  L.push("PROPERTY DEPENDENCY GRAPH — derived from migration source, no database");
  L.push("=".repeat(72));
  L.push(`migration files scanned : ${g.files.length}  (${g.files[0]} … ${g.files[g.files.length - 1]})`);
  L.push(`foreign keys → properties: ${g.edges.length} live` +
         (g.droppedEdges.length ? `  (+${g.droppedEdges.length} on dropped tables, excluded)` : ""));
  L.push(`distinct tables         : ${new Set(g.edges.map((e) => e.table)).size}`);
  L.push("");
  L.push("WHAT A DELETE OF ONE `properties` ROW WOULD DO");
  L.push("-".repeat(72));
  for (const [effect, label] of [["BLOCKS", "refuse the delete"], ["DESTROYS", "delete child rows"], ["ORPHANS", "null the pointer, keep the row"]]) {
    L.push(`  ${effect.padEnd(9)} ${String(byEffect[effect].length).padStart(3)} FKs   ${label}`);
  }
  L.push("");
  L.push("  by declared action:");
  for (const [a, n] of Object.entries(byAction).sort((x, y) => y[1] - x[1])) {
    L.push(`    ${a.padEnd(11)} ${String(n).padStart(3)}`);
  }
  L.push("");
  L.push("  READ THIS BEFORE QUOTING THE NUMBERS ABOVE:");
  L.push("  These are DECLARED edges. Not one of them says a row exists.");
  L.push("  Whether a delete would be refused or would destroy anything");
  L.push("  depends entirely on rows — which is Slice 2's census, not this.");
  L.push("");

  for (const [effect, heading] of [
    ["BLOCKS",   "BLOCKING — any single existing child row refuses the whole delete"],
    ["ORPHANS",  "ORPHANING — the quiet ones: row survives, pointer silently nulled"],
    ["DESTROYS", "CASCADING — child rows are destroyed with the parent"],
  ]) {
    L.push(heading);
    L.push("-".repeat(72));
    const rows = byEffect[effect].slice().sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
    const width = Math.max(...rows.map((e) => `${e.table}.${e.column}`.length), 0) + 4;
    for (const e of rows) {
      L.push("  " + `${e.table}.${e.column}`.padEnd(width) + `${e.action.padEnd(10)} ${e.declaredIn}:${e.line}`);
    }
    L.push("");
  }

  /* ── Rebind surface ─────────────────────────────────────────────── */
  const collidable = g.uniques.filter((u) => u.klass === "COLLIDABLE");
  const singletons = g.uniques.filter((u) => u.klass === "SINGLETON");
  const anchors = g.uniques.filter((u) => u.klass === "ANCHOR");
  L.push("WHAT A REBIND WOULD COLLIDE WITH — the constraint that actually decides");
  L.push("-".repeat(72));
  L.push("  The identity question is not a delete. It is a MIGRATION: repoint one");
  L.push("  property's children onto another row. ON DELETE actions say nothing");
  L.push("  about that. What refuses a repoint is UNIQUENESS.");
  L.push("");
  L.push(`  unique constraints involving property_id : ${g.uniques.length}`);
  L.push(`    ANCHOR      ${String(anchors.length).padStart(3)}  include the row's own id — CANNOT collide on a merge`);
  L.push(`    SINGLETON   ${String(singletons.length).padStart(3)}  at most ONE row per property — collision is GUARANTEED`);
  L.push(`    COLLIDABLE  ${String(collidable.length).padStart(3)}  property_id + a business key — collide IF the key is shared`);
  L.push("");

  const dedupe = (list) => {
    const seen = new Set(), out = [];
    for (const u of list.slice().sort((a, b) => a.table.localeCompare(b.table))) {
      const key = `${u.table}|${u.business.join(",")}|${u.partial || ""}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(u);
    }
    return out;
  };
  const emit = (u, width) => {
    L.push("    " + u.table.padEnd(width) +
           (u.business.length ? `(${u.business.join(", ")})` : "— one per property —"));
    if (u.partial) L.push(" ".repeat(width + 4) + `WHERE ${u.partial}`);
    L.push(" ".repeat(width + 4) + `${u.declaredIn}:${u.line}`);
  };

  const sg = dedupe(singletons);
  if (sg.length) {
    L.push("  SINGLETON — one row per property. Merging two populated properties");
    L.push("  collides here with certainty; no shared business key is required.");
    const w = Math.max(...sg.map((u) => u.table.length)) + 2;
    for (const u of sg) emit(u, w);
    L.push("");
  }
  const cl = dedupe(collidable);
  L.push("  COLLIDABLE — collides only where both properties hold the same key:");
  const w2 = Math.max(...cl.map((u) => u.table.length), 0) + 2;
  for (const u of cl) emit(u, w2);
  L.push("");
  L.push("  A merge fails PART-WAY THROUGH on the first of these that clashes,");
  L.push("  which is a worse outcome than refusing up front. Whether any of them");
  L.push("  actually clash depends on rows — Slice 2's census answers it, this");
  L.push("  file cannot.");
  L.push("");

  if (g.droppedTables.length) {
    L.push(`EXCLUDED — tables dropped by a later migration: ${g.droppedTables.join(", ")}`);
    L.push("");
  }
  L.push("PARSER HONESTY");
  L.push("-".repeat(72));
  if (g.unparsed.length === 0) {
    L.push("  Every statement referencing `properties` was parsed into an edge.");
    L.push("  Zero unparsed. This is asserted, not assumed — see below.");
  } else {
    L.push(`  ⚠ ${g.unparsed.length} statement(s) reference properties and did NOT parse.`);
    L.push("  THE COUNTS ABOVE ARE THEREFORE A FLOOR, NOT A TOTAL:");
    for (const u of g.unparsed) L.push(`    ${u.file}:${u.line}  ${u.text}`);
  }
  L.push("");
  L.push("  This graph is a CATALOG. It cannot see rows, and it describes");
  L.push("  declared migration text — not the deployed database. If the two");
  L.push("  disagree, this file is the one that is wrong.");
  return L.join("\n");
}

if (require.main === module) {
  const g = build();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(g, null, 2));
  } else {
    console.log(report(g));
  }
}

module.exports = { build, report, stripComments };
