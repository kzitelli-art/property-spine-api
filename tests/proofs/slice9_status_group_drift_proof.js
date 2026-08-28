/* ══════════════════════════════════════════════════════════════════════════
   slice9_status_group_drift_proof.js

   The submission / approval / terminal status groups now exist in THREE
   independent places:

     migrations/124_...sql                  compatibility trigger
     src/applications/application_lifecycle.js   the writer
     docs/.../deployment_b/125_...sql       strict enforcement

   Three copies of one rule is three chances to disagree, and the disagreement
   would be invisible until a real application took the wrong path. This
   harness parses EXECUTABLE definitions from all three — never comments — and
   requires exact equality.

   It then MUTATES each source in turn and proves the harness fails, because a
   drift check that has never failed is not a check.

   Run: node tests/proofs/slice9_status_group_drift_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const M124 = path.join(REPO, "migrations/124_application_lifecycle_milestones.sql");
const JS = path.join(REPO, "src/applications/application_lifecycle.js");
const M125 = path.join(REPO, "docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql");

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 52 - t.length)));

const strip = (sql) => sql.replace(/^\s*--.*$/gm, "");          // executable SQL only
const stripJs = (js) => js.replace(/^\s*\/\/.*$/gm, "");        // executable JS only
const quoted = (s) => (s.match(/'([a-z_]+)'/g) || []).map((x) => x.slice(1, -1));
const dquoted = (s) => (s.match(/"([a-z_]+)"/g) || []).map((x) => x.slice(1, -1));

// 124's compatibility trigger writes the groups as inline IN-lists.
function groupsFrom124(src) {
  const body = strip(src);
  const fn = body.slice(body.indexOf("ps_app_compat_author_milestones"));
  const subm = /new\.status in \(([^)]*)\)\s*\n?\s*and not old_submitted/s.exec(fn);
  const appr = /new\.status in \(([^)]*)\)\s*\n?\s*and not old_approved/s.exec(fn);
  const term = /new\.status in \(([^)]*)\) and not old_terminal/s.exec(fn);
  return {
    submission: subm ? quoted(subm[1]) : null,
    approval: appr ? quoted(appr[1]) : null,
    terminal: term ? quoted(term[1]) : null,
  };
}

// 125 declares them as immutable SQL functions.
function groupsFrom125(src) {
  const body = strip(src);
  const grab = (name) => {
    const re = new RegExp(`function ${name}\\(p_status text\\) returns boolean as \\$\\$([\\s\\S]*?)\\$\\$`);
    const m = re.exec(body);
    return m ? quoted(m[1]) : null;
  };
  return {
    submission: grab("ps_app_reached_submission"),
    approval: grab("ps_app_reached_approval"),
    terminal: grab("ps_app_is_terminal"),
  };
}

// The writer declares them as frozen arrays.
function groupsFromJs(src) {
  const body = stripJs(src);
  const grab = (name) => {
    const re = new RegExp(`const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`);
    const m = re.exec(body);
    return m ? dquoted(m[1]) : null;
  };
  return {
    submission: grab("SUBMISSION_REACHED"),
    approval: grab("APPROVAL_REACHED"),
    terminal: grab("TERMINAL"),
  };
}

function readAll() {
  return {
    m124: groupsFrom124(fs.readFileSync(M124, "utf8")),
    js: groupsFromJs(fs.readFileSync(JS, "utf8")),
    m125: groupsFrom125(fs.readFileSync(M125, "utf8")),
  };
}

const same = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

function agreementProblems(g) {
  const problems = [];
  for (const grp of ["submission", "approval", "terminal"]) {
    for (const src of ["m124", "js", "m125"]) {
      if (!Array.isArray(g[src][grp]) || g[src][grp].length === 0) {
        problems.push(`${src}.${grp} could not be parsed`);
      }
    }
    if (!same(g.m124[grp], g.js[grp])) problems.push(`${grp}: 124 vs writer disagree`);
    if (!same(g.js[grp], g.m125[grp])) problems.push(`${grp}: writer vs 125 disagree`);
    if (!same(g.m124[grp], g.m125[grp])) problems.push(`${grp}: 124 vs 125 disagree`);
  }
  return problems;
}

(async () => {
  section("A  the three sources agree today");
  const g = readAll();
  for (const grp of ["submission", "approval", "terminal"]) {
    ok(`${grp} group parsed from all three sources`,
      [g.m124, g.js, g.m125].every((s) => Array.isArray(s[grp]) && s[grp].length > 0));
  }
  const problems = agreementProblems(g);
  ok("all three copies are exactly equal" + (problems.length ? ` — ${problems.join("; ")}` : ""),
    problems.length === 0);
  console.log(`   submission: ${(g.js.submission || []).join(", ")}`);
  console.log(`   approval  : ${(g.js.approval || []).join(", ")}`);
  console.log(`   terminal  : ${(g.js.terminal || []).join(", ")}`);

  section("B  a mutation to ANY single source must fail the check");
  // A drift check that has never failed is not a check.
  const MUTATIONS = [
    { name: "migration 124", file: M124,
      from: "'countersigned','accepted_term_required','active')\n     and not old_approved",
      to: "'accepted_term_required','active')\n     and not old_approved" },
    { name: "application_lifecycle.js", file: JS,
      from: `const TERMINAL = Object.freeze(["declined", "withdrawn", "expired"]);`,
      to: `const TERMINAL = Object.freeze(["declined", "withdrawn"]);` },
    { name: "staged migration 125", file: M125,
      from: `  select p_status in ('submitted','approved','lease_ready','tenant_signed',\n                      'countersigned','accepted_term_required','active');`,
      to: `  select p_status in ('submitted','approved','lease_ready','tenant_signed',\n                      'accepted_term_required','active');` },
  ];

  for (const m of MUTATIONS) {
    const original = fs.readFileSync(m.file, "utf8");
    if (!original.includes(m.from)) {
      ok(`${m.name}: mutation anchor found`, false);
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.from, m.to));
    let detected = false;
    try { detected = agreementProblems(readAll()).length > 0; }
    finally { fs.writeFileSync(m.file, original); }
    ok(`mutating ${m.name} alone is DETECTED`, detected);
    ok(`${m.name} restored byte-for-byte`, fs.readFileSync(m.file, "utf8") === original);
  }

  section("C  the check passes again and no mutation survives");
  ok("post-mutation agreement restored", agreementProblems(readAll()).length === 0);
  // NOT a git-cleanliness check: these files legitimately carry uncommitted
  // work during a correction pass, and conflating that with "my mutation
  // leaked" would make this assertion fail for the wrong reason. The real
  // property is that each file matches the snapshot taken before ITS mutation,
  // which section B verifies byte-for-byte. Re-confirm none of the mutated
  // strings survives anywhere.
  // Assert the ORIGINAL fragment is present, not that the mutated one is
  // absent: a shortened IN-list is a SUBSTRING of the healthy one, so an
  // absence check would fail against a perfectly correct file.
  for (const m of MUTATIONS) {
    ok(`original definition intact in ${path.basename(m.file)}`,
      fs.readFileSync(m.file, "utf8").includes(m.from));
  }

  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
