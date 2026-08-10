#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   DOES MIGRATION 140 DEPEND ON 138 OR 139?

   Owner correction, and it is the right one: a gap in the migration
   numbers is not itself a problem. Numbers do not have to be contiguous.
   The absence of 138/139 from `main` matters in exactly two ways —

     · production's ledger contains 138 or 139, which only the ledger can
       answer (that is Gate 1, and it needs production); or
     · migration 140 DEPENDS on something 138 or 139 creates.

   The second one is answerable from source right now, and this answers
   it. If 140 is independent, it can be merged and released on its own
   without dragging two other migrations along — which changes what
   "merge the intended 140" means.

   ── WHY NOT JUST APPLY IT AND SEE ───────────────────────────────────

   Because the chain cannot be rebuilt from empty. `012_bank_intake.sql`
   fails on `column "yardi_code" does not exist` — a known, owned defect
   (UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md §1, Appendix H), and the
   documented reason a fresh schema is not an option. Reproduced again
   here on Postgres 16: the chain stops at 012. So the dependency is
   established by reading, and this file is explicit that reading is what
   it did.

   ── A MENTION IS NOT A REFERENCE ────────────────────────────────────

   140 is 785 lines, most of them prose. A naive scan pulls "from the",
   "from them" and "from one" out of the commentary and reports them as
   relations. Comments and string literals are therefore removed by a
   lexer that understands PostgreSQL's three quoting forms, INCLUDING
   dollar-quoting — the function bodies are dollar-quoted, and their SQL
   is exactly the part that matters, so they are kept and scanned while
   the error messages inside them are dropped.

       node tools/release0/prove_140_dependencies.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

//  The Release 0 migrations live on unmerged branches. Read from git
//  objects rather than the working tree: merging them is a decision Gate 1
//  gates, and this proof must not be what puts them there.
const R0_BRANCHES = [
  "claude/release-0-rc", "claude/release0-composed", "claude/completion-guard",
  "claude/build-1-2-rc", "claude/build-1-completion-proof-intent",
  "claude/next-build-reporting-intelligence",
];
const R0_FILES = {
  "138": "138_proof_evaluation_defect_obligation.sql",
  "139": "139_no_longer_applicable_resolution.sql",
  "140": "140_post_activation_completion_guard.sql",
};

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/*  ── THE LEXER ──────────────────────────────────────────────────────
 *  Removes what cannot be a reference, keeps what can.
 *    -- line comment        dropped
 *    /* block comment *​/    dropped (nesting is PostgreSQL's rule)
 *    'string literal'       dropped — error messages are full of prose
 *    $tag$ body $tag$       KEPT and scanned; the function bodies are here
 *  Identifier-quoted "names" are kept as-is.                          */
function strip(sql) {
  let out = "", i = 0, n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (two === "/*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; }
        else i++;
      }
      out += " "; continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += " ''"; continue;
    }
    const dq = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dq) {
      const tag = dq[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) { out += sql.slice(i); break; }
      //  Keep the body — it is SQL — and strip it by the same rules.
      out += " " + strip(sql.slice(i + tag.length, end)) + " ";
      i = end + tag.length; continue;
    }
    out += sql[i]; i++;
  }
  return out;
}

//  Objects a migration CREATES, and objects it REFERENCES.
const IDENT = "([a-z_][\\w]*(?:\\.[a-z_][\\w]*)?)";
function creates(sqlStripped) {
  const s = new Set();
  const pats = [
    new RegExp("create\\s+(?:or\\s+replace\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?" + IDENT, "gi"),
    new RegExp("create\\s+(?:or\\s+replace\\s+)?(?:function|procedure)\\s+" + IDENT, "gi"),
    new RegExp("create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?" + IDENT, "gi"),
    new RegExp("create\\s+(?:or\\s+replace\\s+)?(?:view|materialized\\s+view)\\s+" + IDENT, "gi"),
    new RegExp("create\\s+trigger\\s+" + IDENT, "gi"),
    new RegExp("create\\s+type\\s+" + IDENT, "gi"),
    new RegExp("add\\s+constraint\\s+" + IDENT, "gi"),
  ];
  pats.forEach((p) => { let m; while ((m = p.exec(sqlStripped))) s.add(m[1].toLowerCase()); });
  return s;
}
/*  A KEYWORD IS NEVER A RELATION. `after update on public.work_orders` is a
 *  trigger event clause, and a naive `update <ident>` reads "on" out of it;
 *  `insert or update on` yields "or" the same way. Excluding the keyword
 *  class is a fix; excluding "on" and "or" by name would be papering over
 *  an extractor that is still wrong about the next one.                  */
const KEYWORDS = new Set(["on", "or", "and", "not", "if", "exists", "select", "insert",
  "update", "delete", "from", "join", "where", "when", "into", "values", "set", "as",
  "each", "row", "statement", "before", "after", "instead", "of", "for", "execute",
  "function", "trigger", "table", "only", "distinct", "null", "true", "false", "begin",
  "end", "declare", "return", "returns", "new", "old", "public"]);

function references(sqlStripped) {
  const s = new Set();
  const pats = [
    //  `is distinct from old.activation_id` is a comparison against a
    //  trigger record, not a read of a relation called `old`.
    new RegExp("(?<!distinct\\s)\\bfrom\\s+" + IDENT, "gi"),
    new RegExp("\\bjoin\\s+" + IDENT, "gi"),
    new RegExp("\\bupdate\\s+(?:only\\s+)?" + IDENT, "gi"),
    new RegExp("\\binsert\\s+into\\s+" + IDENT, "gi"),
    new RegExp("\\bdelete\\s+from\\s+" + IDENT, "gi"),
    new RegExp("\\breferences\\s+" + IDENT, "gi"),
    new RegExp("\\balter\\s+table\\s+(?:if\\s+exists\\s+)?" + IDENT, "gi"),
    new RegExp("\\bon\\s+" + IDENT + "\\s*$", "gim"),          // trigger targets
    new RegExp("\\bexecute\\s+function\\s+" + IDENT, "gi"),
  ];
  pats.forEach((p) => {
    let m;
    while ((m = p.exec(sqlStripped))) {
      const id = m[1].toLowerCase();
      if (KEYWORDS.has(id)) continue;
      //  OLD.x / NEW.x are the trigger's own records.
      if (/^(old|new)\./.test(id)) continue;
      s.add(id);
    }
  });
  return s;
}
/*  PL/pgSQL LOCALS. `v_at_cutover` is declared in a function's DECLARE
 *  block and then written by `select … into`. It reads like a relation to
 *  a pattern scanner and is not one — it is a text variable. Collected per
 *  DECLARE…BEGIN block so a real relation that merely shares a name is not
 *  swallowed with it.                                                    */
function locals(sqlStripped) {
  const s = new Set();
  const blocks = sqlStripped.match(/\bdeclare\b([\s\S]*?)\bbegin\b/gi) || [];
  blocks.forEach((b) => {
    (b.match(/^\s*([a-z_]\w*)\s+[a-z]/gim) || []).forEach((line) => {
      const m = /^\s*([a-z_]\w*)\s/.exec(line);
      if (m && m[1].toLowerCase() !== "declare") s.add(m[1].toLowerCase());
    });
  });
  return s;
}
//  CTE names look exactly like relations at a `from`. They are local.
function ctes(sqlStripped) {
  const s = new Set(); let m;
  const p = /(?:with|,)\s+([a-z_]\w*)\s+as\s*(?:materialized\s*|not\s+materialized\s*)?\(/gi;
  while ((m = p.exec(sqlStripped))) s.add(m[1].toLowerCase());
  return s;
}
//  PL/pgSQL locals declared in the body, which also appear after `from`
//  in `select … into v_x` shapes are not relations either.
const SQL_NOISE = new Set(["only", "select", "public", "pg_catalog", "current_date",
  "dual", "generate_series", "unnest", "values", "lateral", "old", "new"]);

console.log("\n" + "═".repeat(68));
console.log("  DOES MIGRATION 140 DEPEND ON 138 OR 139?");
console.log("═".repeat(68));
console.log("  ASSERTIONS STARTED\n");

// ── 1 · one unambiguous definition of each ──────────────────────────
const bodies = {};
for (const [v, file] of Object.entries(R0_FILES)) {
  const seen = new Map();
  for (const b of R0_BRANCHES) {
    let text = null;
    try { text = git("cat-file", "-p", `origin/${b}:migrations/${file}`); } catch (_) { continue; }
    seen.set(b, sha(text));
    bodies[v] = text;
  }
  const digests = new Set(seen.values());
  ok(`D${v}  every branch carrying ${v} agrees byte-for-byte (${seen.size} branch(es))`,
     seen.size > 0 && digests.size === 1,
     seen.size === 0 ? `no branch carries migrations/${file}`
       : "MORE THAN ONE DEFINITION EXISTS — 'the intended " + v + "' is ambiguous and " +
         "must be resolved before anything is merged:\n        " +
         [...seen].map(([b, d]) => `${d.slice(0, 12)}  ${b}`).join("\n        "));
}
if (bodies["140"]) console.log(`        140 digest ${sha(bodies["140"]).slice(0, 16)}\n`);

if (!bodies["140"] || !bodies["138"] || !bodies["139"]) {
  console.error("  Cannot proceed without all three definitions.\n");
  process.exit(1);
}

// ── 2 · what 138 and 139 actually create ────────────────────────────
const s138 = strip(bodies["138"]), s139 = strip(bodies["139"]);
const created138 = creates(s138), created139 = creates(s139);
console.log("  ── what 138 creates ──────────────────────────────────────────────");
[...created138].forEach((c) => console.log("     " + c));
console.log("  ── what 139 creates ──────────────────────────────────────────────");
[...created139].forEach((c) => console.log("     " + c));
console.log("");
ok("C1  138 and 139 create at least one nameable object between them",
   created138.size + created139.size > 0,
   "nothing was extracted — the dependency question below cannot be answered and " +
   "a clean result would be an artefact of the extractor finding nothing");

// ── 3 · what 140 references, comments and strings removed ───────────
const s140 = strip(bodies["140"]);
const own140 = creates(s140), cte140 = ctes(s140), loc140 = locals(s140);
const refs140 = [...references(s140)]
  .filter((r) => !own140.has(r) && !cte140.has(r) && !loc140.has(r) && !SQL_NOISE.has(r))
  .filter((r) => !/^release_0_/.test(r) && !/^public\.release_0_/.test(r))
  .sort();

ok("L1  the lexer removed the prose — no English words survive as relations",
   !refs140.some((r) => ["the", "them", "one", "two", "a", "status"].includes(r)),
   "commentary is being reported as schema: " + refs140.join(", "));

console.log("  ── what 140 references (comments + string literals removed) ───────");
refs140.forEach((r) => console.log("     " + r));
console.log("");

// ── 4 · attribute every reference to the migration that creates it ──
const mainFiles = fs.readdirSync(MIGRATIONS)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const origin = new Map();                      // object -> version
for (const f of mainFiles) {
  const v = f.slice(0, 3);
  for (const c of creates(strip(fs.readFileSync(path.join(MIGRATIONS, f), "utf8")))) {
    if (!origin.has(c)) origin.set(c, v);
    if (!origin.has("public." + c)) origin.set("public." + c, v);
  }
}
for (const c of created138) { if (!origin.has(c)) origin.set(c, "138"); }
for (const c of created139) { if (!origin.has(c)) origin.set(c, "139"); }

const attributed = refs140.map((r) => {
  const bare = r.replace(/^public\./, "");
  return { ref: r, from: origin.get(r) || origin.get(bare) || null };
});
const fromR0 = attributed.filter((a) => a.from === "138" || a.from === "139");
const unresolved = attributed.filter((a) => !a.from);

console.log("  ── attribution ───────────────────────────────────────────────────");
attributed.forEach((a) => console.log(
  `     ${(a.from || "UNRESOLVED").padEnd(11)} ${a.ref}`));
console.log("");

// ── 5 · THE ANSWER ──────────────────────────────────────────────────
ok("A1  140 references NOTHING created by 138 or 139",
   fromR0.length === 0,
   "140 DEPENDS on:\n        " + fromR0.map((a) => `${a.ref}  (created by ${a.from})`).join("\n        ") +
   "\n        Those migrations must be merged and released WITH it. 'Release 140 alone' " +
   "is not available.");

//  An unattributed reference is not a pass. It is a reference this proof
//  could not explain, and treating it as harmless is the exact shape of
//  the error this repository keeps writing down.
ok("A2  every reference 140 makes is attributable to a migration",
   unresolved.length === 0,
   "these could not be attributed to any migration file, so this proof CANNOT say " +
   "whether they come from 138/139 or elsewhere:\n        " +
   unresolved.map((a) => a.ref).join("\n        ") +
   "\n        Resolve them by hand before relying on A1.");

const maxDep = attributed.filter((a) => a.from).map((a) => a.from).sort().pop();
ok("A3  140's highest dependency is a migration already in main",
   !!maxDep && mainFiles.some((f) => f.startsWith(maxDep + "_")),
   `highest dependency is ${maxDep}, which main has no file for`);
console.log(`        highest migration 140 depends on: ${maxDep}\n`);

console.log("═".repeat(68));
console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
if (fail === 0 && fromR0.length === 0) {
  console.log("");
  console.log("  140 is INDEPENDENT of 138 and 139. Its dependencies are satisfied by");
  console.log(`  migration ${maxDep}, which is already in main.`);
  console.log("");
  console.log("  So the repo's 137 -> 150 gap is not a Release 0 problem, exactly as");
  console.log("  ruled. Whether 138/139 matter at all is now a question ONLY about");
  console.log("  production's ledger — which is Gate 1, and needs production.");
  console.log("");
  console.log("  NOTE: established by reading, not by applying. The chain cannot be");
  console.log("  rebuilt from empty (012 fails on yardi_code — known, owned,");
  console.log("  UNBLOCK_2 §1). Confirm on a branch of production before releasing.");
}
console.log("═".repeat(68) + "\n");
process.exit(fail === 0 ? 0 : 1);
