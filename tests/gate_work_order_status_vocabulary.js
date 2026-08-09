#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_work_order_status_vocabulary.js — NO SIXTH STATUS ARRIVES QUIETLY.

   ── THE QUESTION THIS ANSWERS ───────────────────────────────────────

   Migration 140 and the four-state reader both define "terminal" as
   `status in ('complete','closed')`. That is only safe while those two
   are the ONLY statuses this system uses to mean the work is finished.
   If a later writer introduces `done`, or `verified`, or `signed_off`:

     · the guard does not fire — it is not one of the two it watches
     · the reader does not call the row terminal, so no defect is raised
     · nothing anywhere reports a problem

   A completion would exist that Release 0 never governs, and the failure
   is SILENT in both directions. That is exactly the drift a runtime check
   cannot see, so it is checked here in source.

   ── WHY NOT A CHECK CONSTRAINT ──────────────────────────────────────

   The obvious move is `alter table work_orders add constraint ... check
   (status in (...)) not valid`. It was considered and REJECTED for now,
   on evidence:

     · `work_orders.status` is `text not null default 'open'` with NO
       check constraint today — measured on the isolated ledger-137
       baseline, not assumed.
     · The vocabulary below is derived from SHIPPED SOURCE. It is not
       derived from production data, and this session must not connect to
       production to find out.
     · A `not valid` check still refuses future INSERTs and UPDATEs. If
       production carries any status this list does not know about, the
       constraint would start refusing ordinary writes on rows nobody was
       trying to complete — an outage caused by a guard, on a value the
       guard did not need to care about.

   "A gate that fails the fix is worse than no gate." The vocabulary is
   pinned in SOURCE, where being wrong costs a red gate instead of a
   refused write. A CHECK becomes the right move once the live vocabulary
   has been read directly — that reading is a production step, not a
   development one, and it is named in the activation runbook.

   ── SCOPE ───────────────────────────────────────────────────────────

   `src/` only. That is the deployed surface. `tools/` and `tests/` write
   statuses freely to build the states these proofs exist to exhibit, and
   they are not part of any running service.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  THE work_orders.status VOCABULARY IS FROZEN AND CLASSIFIED");
console.log("══════════════════════════════════════════════════════════════════\n");

/*  ── THE FROZEN VOCABULARY ──────────────────────────────────────────
 *  Every value shipped source writes to `work_orders.status`, each one
 *  classified terminal or not, each one attributed. Adding a row here is
 *  a deliberate act that forces the question "does this mean the work is
 *  finished?" — which is the entire point of the gate.  */
const FROZEN = {
  open:           { terminal: false,
                    writer: "maintenance/work_order_service.js · comms/tenantlink.js",
                    why: "the default; work is outstanding" },
  scheduled:      { terminal: false, writer: "comms/tenantlink.js",
                    why: "a visit is booked; nothing is finished" },
  needs_followup: { terminal: false, writer: "maintenance/maintenance.js",
                    why: "the technician stalled — the source comment says the work " +
                         "order STAYS OPEN, flagged for review" },
  closed:         { terminal: true,  writer: "maintenance/maintenance.js",
                    why: "the legacy closeout path; terminal, and never a cancellation" },
  complete:       { terminal: true,  writer: "technician/lifecycle_service.js",
                    why: "the canonical writer, in the same transaction as the " +
                         "proof evaluation" },
};

/*  Writers that set the status from a VARIABLE. A variable write is only
 *  safe when the file itself narrows it to a closed list, so the gate
 *  re-reads that list out of the file rather than trusting this comment. */
const VARIABLE_WRITERS = [
  { file: "comms/tenantlink.js",
    //  POST /work-orders/:id/notify-status — `update work_orders set status=$1`
    allowList: /\[\s*"open"\s*,\s*"scheduled"\s*\]\.includes\(\s*status\s*\)/,
    expects: ["open", "scheduled"],
    what: "the notify-status route's own allow-list" },
];

// ── walk src/ and pull every status write out of SQL touching work_orders ──
const files = (function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
})(SRC);

const literalWrites = new Map();     // status -> Set(file)
const variableWrites = new Map();    // file  -> count
const addLit = (v, f) => {
  if (!literalWrites.has(v)) literalWrites.set(v, new Set());
  literalWrites.get(v).add(f);
};

for (const f of files) {
  const rel = path.relative(SRC, f);
  //  Comments stripped: several of these files DISCUSS statuses they do
  //  not write, and a gate that reads prose as code is a gate that
  //  invents findings.
  const code = fs.readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  for (const q of code.match(/`[^`]*work_orders[^`]*`/gi) || []) {
    if (/update\s+(public\.)?work_orders\b/i.test(q)) {
      for (const m of q.matchAll(/\bstatus\s*=\s*'([a-z_]+)'/gi)) addLit(m[1], rel);
      //  `status = $1` / `status=$2` — a value this gate cannot see.
      if (/\bstatus\s*=\s*\$\d/i.test(q)) {
        variableWrites.set(rel, (variableWrites.get(rel) || 0) + 1);
      }
    }
    const ins = /insert\s+into\s+(public\.)?work_orders\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/i.exec(q);
    if (ins) {
      const cols = ins[2].split(",").map((s) => s.trim().replace(/^.*\./, ""));
      const vals = ins[3].split(",").map((s) => s.trim());
      const i = cols.findIndex((cn) => /^status$/i.test(cn));
      if (i >= 0 && vals[i]) {
        const lit = /^'([a-z_]+)'$/i.exec(vals[i]);
        if (lit) addLit(lit[1], rel);
        else variableWrites.set(rel, (variableWrites.get(rel) || 0) + 1);
      }
    }
  }
}

// ── V0 · anti-vacuity ─────────────────────────────────────────────────
/*  A scan that silently matched nothing would pass every assertion below
 *  it. The two ends of the vocabulary must both be found by the scan
 *  itself: the canonical writer's `complete`, and the legacy path's
 *  `closed`. If a refactor moves either out of an inline template
 *  literal, this gate goes red and says so rather than going quiet. */
ok("V0  the scan actually found source to read", files.length > 20,
   files.length + " .js files under src/");
ok("V0a …and found the canonical writer's `complete`",
   literalWrites.has("complete") &&
   [...literalWrites.get("complete")].some((f) => /lifecycle_service\.js$/.test(f)),
   JSON.stringify([...(literalWrites.get("complete") || [])]) +
   " — the scan can no longer see the one write this release governs, so " +
   "every assertion below it is vacuous");
ok("V0b …and the legacy path's `closed`",
   literalWrites.has("closed") &&
   [...literalWrites.get("closed")].some((f) => /maintenance\.js$/.test(f)),
   JSON.stringify([...(literalWrites.get("closed") || [])]));

// ── V1 · no status outside the frozen vocabulary ──────────────────────
const unknown = [...literalWrites.keys()].filter((s) => !(s in FROZEN));
ok("V1  no shipped writer sets a status outside the frozen vocabulary",
   unknown.length === 0,
   unknown.map((s) => `'${s}' written by ` +
     [...literalWrites.get(s)].join(", ")).join(" · ") +
   "\n          → decide whether it means the work is FINISHED. If it does, it " +
   "belongs in the guard's terminal set (migration 140) and in the reader's " +
   "TERMINAL_STATUSES, or completion escapes Release 0 entirely. If it does " +
   "not, add it to FROZEN as terminal:false and say why.");

// ── V2 · every variable write is narrowed by its own file ─────────────
for (const [file, n] of variableWrites) {
  const decl = VARIABLE_WRITERS.find((w) => w.file === file);
  if (!ok(`V2  ${file} sets status from a variable — and is a DECLARED variable writer`,
          !!decl,
          `${n} variable status write(s) in a file this gate does not know about. ` +
          "An unbounded status vocabulary means the terminal set is unbounded too: " +
          "add it to VARIABLE_WRITERS with the allow-list its own code enforces, " +
          "or make the write a literal.")) continue;

  const code = fs.readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  ok(`V2a …and ${decl.what} is still in its executable code`,
     decl.allowList.test(code),
     "the allow-list this gate relies on is gone or reworded — the route may now " +
     "accept any status the caller sends");
  const rogue = decl.expects.filter((s) => !(s in FROZEN) || FROZEN[s].terminal);
  ok(`V2b …and everything it permits is a known, NON-terminal status`,
     rogue.length === 0,
     JSON.stringify(rogue) + " — a route that can set a TERMINAL status is a second " +
     "completion writer, whatever it is called");
}

// ── V3 · the terminal subset is exactly the guard's and the reader's ──
const frozenTerminal = Object.keys(FROZEN).filter((s) => FROZEN[s].terminal).sort();
const { TERMINAL_STATUSES } = require("../src/release0/proof_state.js");
const reader = [...TERMINAL_STATUSES].sort();

ok("V3  the vocabulary's terminal subset equals the reader's terminal set",
   JSON.stringify(frozenTerminal) === JSON.stringify(reader),
   "vocabulary " + JSON.stringify(frozenTerminal) + " vs reader " + JSON.stringify(reader) +
   " — one of them has learned about a completion the other has not");

/*  And the same set, read out of the guard's executable SQL. The
   terminal-set gate already compares the guard to the reader; this
   compares the guard to the VOCABULARY, so a change that updated all
   three copies of the rule but not the classification above still
   fails.  */
const sql = fs.readFileSync(
  path.join(ROOT, "migrations/140_post_activation_completion_guard.sql"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*--.*$/gm, " ");
const guardSets = [...sql.matchAll(/status\s+(?:not\s+)?in\s*\(([^)]*)\)/gi)]
  .map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort());
ok("V3a the guard declares a terminal set at all", guardSets.length > 0,
   "no `status in (...)` in the executable SQL — V3b would compare nothing");
ok("V3b every terminal set in migration 140 equals it too",
   guardSets.every((s) => JSON.stringify(s) === JSON.stringify(frozenTerminal)),
   JSON.stringify(guardSets) + " vs " + JSON.stringify(frozenTerminal));

// ── V4 · the classification is attributed, not asserted ───────────────
const unattributed = Object.entries(FROZEN)
  .filter(([, v]) => !v.writer || !v.why);
ok("V4  every frozen status names its writer and why it is classified that way",
   unattributed.length === 0, JSON.stringify(unattributed.map((x) => x[0])));

console.log("\n  the vocabulary, as shipped source writes it:");
for (const [s, v] of Object.entries(FROZEN)) {
  const seen = literalWrites.has(s) ? "scanned" :
    VARIABLE_WRITERS.some((w) => w.expects.includes(s)) ? "via allow-list" : "NOT SEEN";
  console.log("    " + (v.terminal ? "TERMINAL  " : "          ") +
    s.padEnd(16) + seen.padEnd(15) + v.writer);
}

console.log("\n══════════════════════════════════════════════════════════════════");
console.log(`  passed ${pass}   failed ${fail}`);
console.log("══════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
