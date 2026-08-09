/* ════════════════════════════════════════════════════════════════════
   THE EXACT TERMINAL-WRITER INVENTORY

   "87 scripts open DATABASE_URL with no guard, 67 write-capable" is a
   real warning and the WRONG NUMBER for this decision. Write-capable
   means a script could write something. The question migration 140 turns
   on is narrower:

     WHICH PATHS CAN PUT A TERMINAL STATUS ON A WORK ORDER?

   Everything else is noise. This finds them by scanning for the two
   operations that can do it — an INSERT naming `status`, and an UPDATE
   whose SET list assigns `status` — and classifies each by whether the
   value can be terminal.

   ── WHY A SCAN AND NOT A HAND LIST ──────────────────────────────────

   A hand list is accurate on the day it is written. This is re-derived
   every run and compared to FROZEN_SHIPPED, so a new shipped writer
   fails the gate instead of arriving unnoticed.

   ── THE CLASSIFICATION IS DELIBERATELY PESSIMISTIC ──────────────────

   A bound parameter (`status = $1`) counts as TERMINAL-CAPABLE even when
   the caller happens to guard it in application code, because that guard
   is one edit away from being wrong and is not what the database sees.
   `tenantlink.js` is exactly that case: it refuses 'complete' and allows
   only open/scheduled today.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

//  The reader's terminal set. Imported rather than restated so this
//  inventory cannot disagree with what "terminal" means elsewhere.
const { TERMINAL_STATUSES } = require("../../src/release0/proof_state.js");

/*  FROZEN: the shipped paths that can write a terminal work-order status.
 *  Three, and each is accounted for:
 *
 *    lifecycle_service.js   the CANONICAL writer. Legal by definition —
 *                           it records the evaluation in the same
 *                           transaction, so it satisfies the guard.
 *    maintenance.js         the LEGACY closeout. Step 6 makes it fail
 *                           closed at the route; the guard refuses it at
 *                           the database even if Step 6 is reverted.
 *    tenantlink.js          PARAMETERIZED (`status = $1`), and guarded in
 *                           application code to open|scheduled. Counted
 *                           as terminal-capable anyway: the guard is one
 *                           edit away from wrong, and the database sees
 *                           only the parameter.
 *
 *  Adding to this list is a deliberate act. If the gate fails, read the
 *  new site and decide whether it is legitimate BEFORE editing this. */
const FROZEN_SHIPPED = [
  "src/comms/tenantlink.js",
  "src/maintenance/maintenance.js",
  "src/technician/lifecycle_service.js",
];

const SHIPPED = (rel) => rel.startsWith("src/") || rel === "server.js";
//  Proof harnesses run against the isolated baseline and are expected to
//  write terminal statuses — that is what they are proving. They are NOT
//  production utilities, and conflating the two is how the 67 number got
//  used for a question it does not answer.
//  NAMED DIRECTORIES, never a blanket `tools/*`. The whole value of W3 is
//  that a NEW directory under tools/ is flagged until someone decides what
//  it is — which is exactly what happened when tools/build1/ appeared, and
//  the decision was that its two files are proof harnesses of the same kind
//  as tools/step12/'s. Widening this to all of tools/ would remove the
//  question rather than answer it.
const HARNESS = (rel) =>
  /^tools\/(step\d+|steps23|scale|savepoint|activation|build1)\//.test(rel) ||
  rel.startsWith("tests/");
const UTILITY = (rel) => rel.startsWith("tools/") && !HARNESS(rel);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|sql)$/.test(e.name)) out.push(p);
  }
  return out;
}

function scan(root) {
  const files = [
    ...walk(path.join(root, "src")),
    ...walk(path.join(root, "tools")),
    ...walk(path.join(root, "tests")),
    path.join(root, "server.js"),
  ].filter((f) => fs.existsSync(f));

  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(root, f);
    const at = (i) => src.slice(0, i).split("\n").length;

    const upd = /update\s+(?:public\.)?work_orders\b[\s\S]{0,400}?\bset\b([\s\S]{0,300}?)(?:where|returning|`|;)/gi;
    let m;
    while ((m = upd.exec(src))) {
      if (!/\bstatus\s*=/.test(m[1])) continue;
      const val = (m[1].match(/\bstatus\s*=\s*([^,\n]+)/) || [])[1] || "";
      const lit = (val.match(/'([a-z_]+)'/) || [])[1];
      hits.push({ rel, op: "UPDATE", line: at(m.index),
        value: lit ? `'${lit}'` : val.trim().slice(0, 20),
        //  A bound parameter is pessimistically terminal-capable.
        terminalCapable: lit ? TERMINAL_STATUSES.includes(lit) : true,
        parameterized: !lit });
    }

    const ins = /insert\s+into\s+(?:public\.)?work_orders\s*\(([\s\S]{0,600}?)\)([\s\S]{0,600}?)(?:;|`)/gi;
    while ((m = ins.exec(src))) {
      if (!/\bstatus\b/.test(m[1])) continue;
      const lit = (m[2].match(/'([a-z_]+)'/) || [])[1];
      hits.push({ rel, op: "INSERT", line: at(m.index),
        value: lit ? `'${lit}'` : "(bound)",
        terminalCapable: lit ? TERMINAL_STATUSES.includes(lit) : true,
        parameterized: !lit });
    }
  }
  return hits.map((h) => Object.assign(h, {
    shipped: SHIPPED(h.rel), harness: HARNESS(h.rel), utility: UTILITY(h.rel),
  }));
}

module.exports = { scan, FROZEN_SHIPPED, SHIPPED, HARNESS, UTILITY };
