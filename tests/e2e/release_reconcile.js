#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    RELEASE RECONCILIATION — 177..187 AGAINST A REAL LEDGER.

    Answers, per migration, the eight questions that decide a release:
      WHAT FACT · DEPENDENCIES · ALREADY RELEASED · STILL REQUIRED ·
      SUPERSEDED · COLLIDES WITH LIVE LEDGER · SAFE ADDITIVELY ·
      PROOF THAT DEPENDS ON IT

    THREE OF THOSE CANNOT BE ANSWERED FROM THIS BRANCH. Already-released,
    collision, and the true ceiling are facts about production, and this
    tool REFUSES to guess them. Without a ledger it prints them as
    `UNKNOWN — needs ledger` and exits non-zero, because a release plan
    with three unknown columns is not a release plan.

    Give it the ledger and it becomes a decision:

      node tests/e2e/release_reconcile.js --ledger 187,186,185,...
      node tests/e2e/release_reconcile.js --ledger-file live_ledger.txt
      node tests/e2e/release_reconcile.js --db "postgres://..."

    The ledger is `select version from schema_migrations` — nothing else.
    Filenames, git history and handoffs are NOT evidence of what is live.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const RANGE = [177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187];

//  WHAT EACH ONE IS FOR, and which proof would die without it. Written
//  from the migration headers and from which harness actually exercises
//  it — not from memory of what they were meant to do.
const INTENT = {
  177: { fact: "records whether ingress CREATED a person or RECOGNISED an existing one",
         proof: "none in the leasing suite", lane: "person ingress" },
  178: { fact: "a named leasing cycle as property configuration over dates",
         proof: "none in the leasing suite (Ask Spine forward-cycle reads it)", lane: "leasing cycles" },
  179: { fact: "why THIS tracker version is the operating source (supersession)",
         proof: "none in the leasing suite", lane: "activation source" },
  180: { fact: "retired inventory is retained as history and leaves current inventory",
         proof: "none directly; GATES browser proof of Skyline bed targeting", lane: "inventory repair" },
  181: { fact: "meeting evidence binding, finality, extraction lineage",
         proof: "none in the leasing suite", lane: "meeting evidence" },
  182: { fact: "an application carries an EXACT space, enforced by trigger",
         proof: "clean path · reconciliation (exact_space) · hostile", lane: "LEASING" },
  183: { fact: "pricing overrides become possible (101 shipped columns an index forbade)",
         proof: "governed price step; space economics", lane: "LEASING" },
  184: { fact: "a packet may carry a governing instrument and be executed in Spine",
         proof: "clean path · hostile (placeholder, hash, order) · reconciliation", lane: "LEASING" },
  185: { fact: "an executed lease records HOW it was verified + packet lineage",
         proof: "clean path (spine_instrument/spine_esign) · hostile", lane: "LEASING" },
  186: { fact: "durable property lease configuration (the Class-2 map's removal condition)",
         proof: "lease packet generation for any property but the demo", lane: "LEASING" },
  187: { fact: "leases.security_deposit — the canonical tenancy writer inserts it",
         proof: "tenancy anchor; confirmTermService had NEVER written a lease", lane: "LEASING" },
};

function fileFor(n) {
  const hits = fs.readdirSync(path.join(ROOT, "migrations"))
    .filter((f) => f.startsWith(String(n) + "_") && f.endsWith(".sql"));
  return hits.length ? path.join(ROOT, "migrations", hits[0]) : null;
}
function declaredPrereqs(sql) {
  const out = new Set();
  const m = sql.match(/version\s+in\s*\(([^)]*)\)/i);
  if (m) for (const v of m[1].match(/'(\d+)'/g) || []) out.add(v.replace(/'/g, ""));
  for (const v of sql.match(/version\s*=\s*'(\d+)'/g) || []) out.add(v.replace(/.*'(\d+)'.*/, "$1"));
  return [...out].sort();
}
function createdObjects(sql) {
  const re = /create\s+(?:unique\s+)?(table|index|trigger|type)(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)/gi;
  const out = new Set(); let m;
  while ((m = re.exec(sql))) out.add(`${m[1].toLowerCase()}:${m[2].toLowerCase()}`);
  return [...out];
}
function additive(sql) {
  //  Destructive verbs that are NOT the idempotent constraint/trigger
  //  re-declaration pattern every migration here uses. `drop index` and
  //  `drop constraint` count: 183 REPLACES an index shipped by 101, and
  //  replacing a uniqueness rule is a behaviour change, not an addition.
  const bad = sql.match(/\b(drop\s+table|drop\s+column|drop\s+index|truncate|delete\s+from|update\s+[a-z_]+\s+set)\b/gi) || [];
  return bad.length === 0 ? "yes" : "REVIEW: " + [...new Set(bad.map((b) => b.toLowerCase().replace(/\s+/g, " ")))].join(", ");
}

//  ── WHAT CAN FAIL AGAINST ROWS THAT ALREADY EXIST ──────────────────
//  A migration that applies cleanly to an empty test schema can still be
//  refused by production, and only three things do it: a UNIQUE index over
//  data that already has duplicates, a NOT NULL column added to a populated
//  table, and a CHECK constraint over rows that already violate it.
//
//  This is the difference between "it applied locally" and "it will apply".
//  Our local schema was built from empty, so NONE of these were exercised
//  against real data — the whole point of stating them is that our green
//  local run is not evidence about production here.
//
//  Each one gets the exact query to run against production BEFORE release.
function dataPreconditions(sql, n) {
  const out = [];
  //  ⚠ THE COLUMN LIST IS PAREN-BALANCED, NOT `[^)]*`.
  //  An index over `lower(trim(cycle_label))` stops a lazy match at the
  //  FIRST `)`, producing `lower(trim(cycle_label` — a query that looks
  //  right in a report and errors when pasted. A preflight check nobody
  //  can run is worse than none, because it gets skipped rather than
  //  fixed. Caught by executing every generated query, not by reading it.
  const uniqHead = /create\s+unique\s+index(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)\s+on\s+([a-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = uniqHead.exec(sql))) {
    let depth = 1, i = uniqHead.lastIndex;
    while (i < sql.length && depth > 0) { if (sql[i] === "(") depth++; else if (sql[i] === ")") depth--; i++; }
    const rawCols = sql.slice(uniqHead.lastIndex, i - 1);
    const tail = sql.slice(i, sql.indexOf(";", i));
    const wm = tail.match(/\s*where\s+[\s\S]*/i);
    const cols = rawCols.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
    const where = (wm ? wm[0] : "").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
    out.push({
      risk: "UNIQUE over existing rows",
      object: m[1],
      check: `select ${cols}, count(*) from ${m[2]} ${where} group by ${cols} having count(*) > 1;`,
      meaning: "any row returned means this index CANNOT be created until the duplicates are resolved",
    });
  }
  const notnull = /alter\s+table\s+([a-z0-9_]+)[\s\S]{0,400}?add\s+column(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)[^,;]*\bnot\s+null\b(?![^,;]*default)/gi;
  while ((m = notnull.exec(sql))) {
    out.push({
      risk: "NOT NULL with no default on a populated table",
      object: `${m[1]}.${m[2]}`,
      check: `select count(*) from ${m[1]};`,
      meaning: "any existing row makes this fail unless a default or backfill is supplied",
    });
  }
  const chk = /alter\s+table\s+([a-z0-9_]+)\s+add\s+constraint\s+([a-z0-9_]+)\s+check\s*\(([\s\S]*?)\);/gi;
  while ((m = chk.exec(sql))) {
    out.push({
      risk: "CHECK over existing rows",
      object: m[2],
      //  Strip SQL line comments BEFORE flattening. A migration's check
      //  body is commented for readers; flattened to one line those `--`
      //  comments swallow the rest of the statement, and a preflight query
      //  that cannot be pasted is a preflight query nobody runs.
      check: `select count(*) from ${m[1]} where not (${m[3].replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim()});`,
      meaning: "a non-zero count means existing production rows violate this constraint",
    });
  }
  return out;
}

// ── the ledger, from a real source or not at all ────────────────────
function readLedger(argv) {
  const i = argv.indexOf("--ledger");
  if (i > -1 && argv[i + 1]) return argv[i + 1].split(/[,\s]+/).filter(Boolean);
  const f = argv.indexOf("--ledger-file");
  if (f > -1 && argv[f + 1]) {
    return fs.readFileSync(argv[f + 1], "utf8").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  }
  return null;
}

(async () => {
  const argv = process.argv.slice(2);
  let ledger = readLedger(argv);
  const dbIdx = argv.indexOf("--db");
  if (!ledger && dbIdx > -1 && argv[dbIdx + 1]) {
    const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
    const pool = new Pool({ connectionString: argv[dbIdx + 1] });
    ledger = (await pool.query("select version from schema_migrations order by version")).rows.map((r) => String(r.version));
    await pool.end();
    console.log(`  ledger read from the database: ${ledger.length} entries\n`);
  }
  const known = ledger ? new Set(ledger.map((v) => String(Number(v)))) : null;
  const ceiling = ledger ? Math.max(...ledger.map(Number).filter(Number.isFinite)) : null;

  console.log("═".repeat(78));
  console.log("  RELEASE RECONCILIATION  ·  migrations 177–187");
  console.log(ledger ? `  live ledger supplied · ceiling ${ceiling} · ${ledger.length} entries`
                     : "  ⚠ NO LEDGER SUPPLIED — three columns cannot be answered and are not guessed");
  console.log("═".repeat(78));

  let unresolved = 0;
  for (const n of RANGE) {
    const f = fileFor(n);
    if (!f) { console.log(`\n  ${n}  NO FILE ON THIS BRANCH`); continue; }
    const sql = fs.readFileSync(f, "utf8");
    const info = INTENT[n] || { fact: "(undocumented)", proof: "(unknown)", lane: "?" };
    const prereqs = declaredPrereqs(sql);
    const objs = createdObjects(sql);

    let released, collides;
    if (!known) { released = "UNKNOWN — needs ledger"; collides = "UNKNOWN — needs ledger"; unresolved++; }
    else {
      released = known.has(String(n)) ? "YES — already in the live ledger" : "no";
      collides = known.has(String(n))
        ? "VERSION NUMBER TAKEN — compare content before assuming it is the same migration"
        : (ceiling >= n ? `number is BELOW the live ceiling (${ceiling}) — renumber if branch-only` : "no");
    }
    const missingPrereq = known ? prereqs.filter((p) => !known.has(String(Number(p)))) : [];

    console.log(`\n── ${n}  ${path.basename(f)}`);
    console.log(`   lane          ${info.lane}`);
    console.log(`   fact          ${info.fact}`);
    console.log(`   dependencies  ${prereqs.length ? prereqs.join(", ") : "none declared"}` +
                (missingPrereq.length ? `   ⚠ NOT IN LEDGER: ${missingPrereq.join(", ")}` : ""));
    console.log(`   already live  ${released}`);
    console.log(`   collides      ${collides}`);
    console.log(`   additive      ${additive(sql)}`);
    console.log(`   creates       ${objs.length ? objs.join(", ") : "(alters only)"}`);
    console.log(`   proof needs   ${info.proof}`);
    const pre = dataPreconditions(sql, n);
    if (!pre.length) console.log("   preflight     none — nothing here can be refused by existing rows");
    else {
      console.log(`   preflight     ${pre.length} check(s) MUST be run against production first:`);
      for (const c of pre) {
        console.log(`                 · ${c.risk} — ${c.object}`);
        console.log(`                     ${c.check}`);
        console.log(`                     ${c.meaning}`);
      }
    }
  }

  console.log(`\n${"═".repeat(78)}`);
  if (unresolved) {
    console.log(`  ${unresolved} migration(s) carry UNANSWERED release questions.`);
    console.log("  Supply the live ledger and re-run:");
    console.log("      select version from schema_migrations order by version;");
    console.log("      node tests/e2e/release_reconcile.js --ledger-file live_ledger.txt");
    console.log("  Do NOT sequence a release, or assign a migration number, without it.");
  } else {
    console.log("  Every column answered against a real ledger. Review before releasing.");
  }
  console.log("═".repeat(78));
  process.exit(unresolved ? 2 : 0);
})().catch((e) => { console.error("DIED: " + e.stack); process.exit(1); });
