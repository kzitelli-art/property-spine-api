// ════════════════════════════════════════════════════════════════════
//  migration_release_gate.test.js — DB-FREE. Proves the ITEM 5 gate DECIDES
//  correctly, by stubbing `pg` so migrate.js talks to a fake ledger.
//
//  WHY THIS EXISTS. Twice today a safety check was shipped that had never
//  executed — a read-only smoke whose probe aborted its own transaction, and a
//  closure gate blind since a directory move. Both read as protection. Neither
//  ran. This gate stops production deploys, so it does not get to be the third.
//
//  Runs migrate.js as a child process with `pg` intercepted at module-load
//  time (NODE_PATH does not work — the real node_modules/pg wins), and asserts
//  on exit code + output.
// ════════════════════════════════════════════════════════════════════
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

let pass = 0, fail = 0;
const ok = (l) => { console.log("  ok    " + l); pass++; };
const bad = (l, d) => { console.log("  FAIL  " + l + (d ? "  →  " + d : "")); fail++; };

// Intercept `pg` at module-load time so migrate.js talks to a ledger we
// control. NODE_PATH is NOT enough: node resolves node_modules first, so the
// real driver wins and the test dials a nonexistent host.
const PRELOAD = path.join(os.tmpdir(), "ps_pg_intercept.js");
fs.writeFileSync(PRELOAD, `
  const Module = require("module");
  const original = Module._load;
  const LEDGER = JSON.parse(process.env.__STUB_LEDGER || "[]");
  class Client {
    async connect() {}
    async end() {}
    async query(sql) {
      if (/from schema_migrations/i.test(String(sql))) return { rows: LEDGER };
      return { rows: [] };
    }
  }
  Module._load = function (request) {
    if (request === "pg") return { Client, Pool: Client };
    return original.apply(this, arguments);
  };
`);

function run(ledgerRows, env, args = []) {
  try {
    const out = execFileSync(process.execPath,
      ["--require", PRELOAD, path.join(__dirname, "..", "..", "migrations", "migrate.js"), ...args],
      { env: { ...process.env, __STUB_LEDGER: JSON.stringify(ledgerRows),
               DATABASE_URL: "postgres://stub/stub", ...env },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// The real migrations directory is the input; build a ledger from it.
const files = fs.readdirSync(path.join(__dirname, "..", "..", "migrations"))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();
const asRow = (f) => ({ version: f.slice(0, 3), name: f.slice(4, -4) });
const ALL = files.map(asRow);
const MISSING_LAST = ALL.slice(0, -1);          // newest migration unapplied
const ceilingOfAll = ALL.map((r) => r.version).sort().pop();
const ceilingOfMissing = MISSING_LAST.map((r) => r.version).sort().pop();

console.log("\n═══ ITEM 5 — migration release gate ═══\n");
console.log(`  (using the real migrations/ directory: ${files.length} files, newest ${files[files.length - 1]})\n`);

// 1. VERIFY, everything applied → passes, applies nothing.
{
  const r = run(ALL, {});
  ok_or(r.code === 0 && /SCHEMA VERIFIED/.test(r.out),
    "verify: all applied → starts", `exit=${r.code}`);
  ok_or(!/applying\.\.\./.test(r.out), "verify: applied nothing", "it applied something");
}

// 2. VERIFY, one pending → REFUSES TO START. This is the whole point.
{
  const r = run(MISSING_LAST, {});
  ok_or(r.code === 1 && /REFUSING TO START/.test(r.out),
    "verify: pending migration → refuses to start", `exit=${r.code}`);
  ok_or(/does not match this code/.test(r.out),
    "verify: says the schema does not match the code");
  ok_or(!/applying\.\.\./.test(r.out),
    "verify: pending migration was NOT silently applied", "it applied it");
  ok_or(new RegExp(files[files.length - 1]).test(r.out),
    "verify: names the pending migration");
}

// 3. RELEASE without EXPECTED_LEDGER_CEILING → refused.
{
  const r = run(MISSING_LAST, { MIGRATION_RELEASE: "1" });
  ok_or(r.code === 1 && /EXPECTED_LEDGER_CEILING is required/.test(r.out),
    "release: refused without a stated expectation", `exit=${r.code}`);
}

// 4. RELEASE with the WRONG ceiling → refused (something moved since you looked).
{
  const r = run(MISSING_LAST, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "001" });
  ok_or(r.code === 1 && /not in the expected state/.test(r.out),
    "release: refused when the ledger moved since inspection", `exit=${r.code}`);
}

// 5. RELEASE on a Render build without EXPECTED_SHA → refused.
{
  const r = run(MISSING_LAST, {
    MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfMissing,
    RENDER_GIT_COMMIT: "abc123def456789",
  });
  ok_or(r.code === 1 && /EXPECTED_SHA is required/.test(r.out),
    "release: refused on a deployed build with no pinned SHA", `exit=${r.code}`);
}

// 6. RELEASE with a MISMATCHED SHA → refused.
{
  const r = run(MISSING_LAST, {
    MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfMissing,
    RENDER_GIT_COMMIT: "abc123def456789", EXPECTED_SHA: "999999999999",
  });
  ok_or(r.code === 1 && /not the build you authorised/.test(r.out),
    "release: refused when the running build is not the authorised one", `exit=${r.code}`);
}

// 6b. A PIN TOO SHORT TO PIN ANYTHING → refused.
//     `EXPECTED_SHA=3` prefix-matches about one commit in sixteen. The old
//     comparison accepted it and printed nothing.
{
  const r = run(MISSING_LAST, {
    MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfMissing,
    RENDER_GIT_COMMIT: "abc123def456789", EXPECTED_SHA: "abc",
  });
  ok_or(r.code === 1 && /not a usable pin/.test(r.out),
    "release: refused a sha prefix short enough to match many commits", `exit=${r.code}`);
}

// 7. A feature branch cannot migrate production by deploying. (Same as case 2,
//    stated as the property that matters rather than the mechanism.)
{
  const r = run(MISSING_LAST, { RENDER_GIT_COMMIT: "feature123" });
  ok_or(r.code === 1 && !/applied and recorded/.test(r.out),
    "PROPERTY: a branch deploy with a new migration neither migrates nor boots");
}

// ════════════════════════════════════════════════════════════════════
//  8. THE HOLE THIS SECTION EXISTS TO CLOSE.
//
//  EXPECTED_SHA used to be read only inside `if (RENDER_GIT_COMMIT)`. A
//  release run from a laptop, a container or another agent's environment
//  could pass EXPECTED_SHA=<anything> and the runner compared it to
//  nothing and printed no error — while the runbook said "pin the exact
//  code being released". The documentation asserted more than the
//  executable measured, which is the defect class this whole harness
//  exists for.
//
//  These cases run migrate.js from a SCRATCH GIT REPOSITORY built here, so
//  HEAD and cleanliness are facts we set rather than properties of whatever
//  tree the suite happens to run in. Proving this against the real repo
//  would pass or fail depending on uncommitted work — a green that measured
//  the checkout, not the guard.
// ════════════════════════════════════════════════════════════════════
{
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ps_release_sha_"));
  const REAL = path.join(__dirname, "..", "..", "migrations");
  const MIGDIR = path.join(SCRATCH, "migrations");
  fs.mkdirSync(MIGDIR);
  for (const f of fs.readdirSync(REAL)) {
    if (fs.statSync(path.join(REAL, f)).isFile()) fs.copyFileSync(path.join(REAL, f), path.join(MIGDIR, f));
  }
  const git = (...args) => execFileSync("git", args, { cwd: SCRATCH, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "scratch");
  git("-c", "user.email=proof@spine.local", "-c", "user.name=proof", "add", "-A");
  git("-c", "user.email=proof@spine.local", "-c", "user.name=proof", "commit", "-q", "-m", "scratch build");
  const HEAD = git("rev-parse", "HEAD");

  const runScratch = (ledgerRows, env) => {
    const e = { ...process.env, __STUB_LEDGER: JSON.stringify(ledgerRows),
                DATABASE_URL: "postgres://stub/stub", ...env };
    delete e.RENDER_GIT_COMMIT;              // the whole point: NOT a Render release
    try {
      return { code: 0, out: execFileSync(process.execPath,
        ["--require", PRELOAD, path.join(MIGDIR, "migrate.js")],
        { env: e, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) { return { code: err.status, out: (err.stdout || "") + (err.stderr || "") }; }
  };
  const RELEASE = { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfMissing };

  //  THE DELIBERATELY WRONG SHA. Well-formed, right length, not this build.
  {
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: "0123456789abcdef0123456789abcdef01234567" });
    ok_or(r.code === 1 && /not the build you authorised/.test(r.out),
      "OFF-RENDER: a wrong SHA is refused — this is the case that used to pass silently", `exit=${r.code}`);
    ok_or(/git HEAD/.test(r.out),
      "OFF-RENDER: the refusal names git HEAD as what it compared against", r.out.slice(-300));
    ok_or(!/applying\.\.\./.test(r.out),
      "OFF-RENDER: nothing was applied on the way to that refusal", "it applied something");
  }

  //  THE EXACT BUILD. Accepted, and the banner says the pin was verified.
  {
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: HEAD });
    ok_or(r.code === 0, "OFF-RENDER: the exact HEAD sha is ACCEPTED", `exit=${r.code} :: ${r.out.slice(-300)}`);
    ok_or(/sha pin:\s+VERIFIED against git HEAD/.test(r.out),
      "OFF-RENDER: the banner reports the pin as verified, and against what", r.out.slice(-400));
  }

  //  A SHORT PREFIX OF THE REAL SHA still matches, as it always did — the
  //  min-length rule bounds it, it does not forbid abbreviation.
  {
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: HEAD.slice(0, 12) });
    ok_or(r.code === 0, "OFF-RENDER: a 12-character abbreviation of the real sha still works", `exit=${r.code}`);
  }

  //  UNPINNED. Still permitted off-Render — several Class-3 seeding tools
  //  release this way — but it must SAY so rather than print a blank.
  {
    const r = runScratch(MISSING_LAST, RELEASE);
    ok_or(r.code === 0, "OFF-RENDER: omitting EXPECTED_SHA is still allowed", `exit=${r.code}`);
    ok_or(/NOT PINNED/.test(r.out) && /no build was authorised/.test(r.out),
      "OFF-RENDER: …and an unpinned release SAYS it authorised no build", r.out.slice(-400));
  }

  //  A PIN OVER A MODIFIED TREE. The sha matches and the code does not.
  {
    fs.appendFileSync(path.join(MIGDIR, "README.md"), "\nedited after the commit\n");
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: HEAD });
    ok_or(r.code === 1 && /does not describe this working tree/.test(r.out),
      "OFF-RENDER: a matching sha over MODIFIED tracked files is refused", `exit=${r.code}`);
    ok_or(/README\.md/.test(r.out),
      "OFF-RENDER: …and the refusal names the file that diverged", r.out.slice(-400));
    git("checkout", "--", "migrations/README.md");
  }

  //  AN UNTRACKED FILE IS NOT THE RELEASE. .env and scratch output must not
  //  block a legitimate release at the worst possible moment.
  {
    fs.writeFileSync(path.join(SCRATCH, ".env"), "SECRET=notpartofthebuild\n");
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: HEAD });
    ok_or(r.code === 0, "OFF-RENDER: an untracked file does not block the release", `exit=${r.code} :: ${r.out.slice(-200)}`);
    fs.unlinkSync(path.join(SCRATCH, ".env"));
  }

  // ──────────────────────────────────────────────────────────────────
  //  THE HOSTILE CASE: AN UNTRACKED MIGRATION UNDER A VERIFIED PIN.
  //
  //  The first version of this guard asked git for a dirty tree with
  //  `--untracked-files=no`, which is right for .env and screenshots and
  //  WRONG for a migration — because this runner executes
  //  migrations/NNN_*.sql from the FILESYSTEM, not from the commit. So a
  //  file no commit contains was invisible to the check and fully
  //  executable, and the release would have printed "VERIFIED against git
  //  HEAD" while running schema that sha does not contain.
  //
  //  Three assertions, in order: the runner DOES discover it, an unpinned
  //  release DOES apply it, and a pinned release now refuses first.
  // ──────────────────────────────────────────────────────────────────
  {
    const HOSTILE = "990_untracked_hostile.sql";
    fs.writeFileSync(path.join(MIGDIR, HOSTILE), "-- present on disk, in no commit\nselect 1;\n");
    const ALL_APPLIED = { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfAll };

    //  (a) IT IS REACHABLE. Not argued — verify mode names it as pending,
    //      which is the runner saying it intends to apply it.
    const seen = runScratch(ALL, {});
    ok_or(seen.code === 1 && new RegExp(HOSTILE).test(seen.out),
      "HOSTILE: the runner DISCOVERS an untracked migration from the filesystem", `exit=${seen.code}`);

    //  (b) IT IS APPLIED when nothing pins the release. This is the damage,
    //      executed against the stubbed ledger rather than described.
    const unpinned = runScratch(ALL, ALL_APPLIED);
    ok_or(unpinned.code === 0 && new RegExp(HOSTILE + "\\s+— applying").test(unpinned.out),
      "HOSTILE: an UNPINNED release applies it — the hole, run", unpinned.out.slice(-400));

    //  (c) AND A VERIFIED PIN NOW REFUSES. Before anything is applied.
    const pinned = runScratch(ALL, { ...ALL_APPLIED, EXPECTED_SHA: HEAD });
    ok_or(pinned.code === 1 && /NOT in the pinned commit/.test(pinned.out),
      "HOSTILE: a matching sha with an untracked migration on disk is REFUSED", `exit=${pinned.code} :: ${pinned.out.slice(-300)}`);
    ok_or(new RegExp("migrations/" + HOSTILE).test(pinned.out),
      "HOSTILE: …the refusal NAMES the untracked migration", pinned.out.slice(-400));
    ok_or(!/applying\.\.\./.test(pinned.out),
      "HOSTILE: …and it refuses BEFORE anything is applied", "it applied something");
    //  Asserted against the BANNER LINE, not the word. The refusal text
    //  itself says "a release that prints VERIFIED must have verified
    //  everything it is about to run" — a bare /VERIFIED/ search matches
    //  the explanation and calls the refusal a false claim.
    ok_or(!/sha pin:\s+VERIFIED/.test(pinned.out),
      "HOSTILE: …and the VERIFIED banner is never printed on the way to refusing", pinned.out.slice(-300));

    fs.unlinkSync(path.join(MIGDIR, HOSTILE));
  }

  //  SCOPED BY FILE CLASS, NOT BY DIRECTORY. An untracked file that cannot
  //  participate in a release must not block one, even sitting in
  //  migrations/ — banning the directory would strand a release on a note.
  {
    fs.writeFileSync(path.join(MIGDIR, "scratch_notes.md"), "not a migration\n");
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: HEAD });
    ok_or(r.code === 0, "SCOPE: an untracked NON-migration inside migrations/ does not block the release",
      `exit=${r.code} :: ${r.out.slice(-300)}`);
    fs.unlinkSync(path.join(MIGDIR, "scratch_notes.md"));
  }

  //  A TRACKED MIGRATION IN A SUBDIRECTORY CANNOT VOUCH FOR AN UNTRACKED
  //  ONE BESIDE THE RUNNER. `ls-tree` is non-recursive for exactly this.
  {
    const SUB = path.join(MIGDIR, "archive");
    fs.mkdirSync(SUB, { recursive: true });
    fs.writeFileSync(path.join(SUB, "991_decoy.sql"), "select 1;\n");
    git("-c", "user.email=proof@spine.local", "-c", "user.name=proof", "add", "-A");
    git("-c", "user.email=proof@spine.local", "-c", "user.name=proof", "commit", "-q", "-m", "archive a decoy");
    const HEAD2 = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(MIGDIR, "991_decoy.sql"), "-- different file, same name\nselect 1;\n");
    const r = runScratch(ALL, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfAll, EXPECTED_SHA: HEAD2 });
    ok_or(r.code === 1 && /NOT in the pinned commit/.test(r.out),
      "SCOPE: a tracked subdirectory file of the same NAME does not launder an untracked migration",
      `exit=${r.code} :: ${r.out.slice(-300)}`);
    fs.unlinkSync(path.join(MIGDIR, "991_decoy.sql"));
    fs.rmSync(SUB, { recursive: true, force: true });
    git("-c", "user.email=proof@spine.local", "-c", "user.name=proof", "add", "-A");
    git("-c", "user.email=proof@spine.local", "-c", "user.name=proof", "commit", "-q", "-m", "remove decoy");
  }

  //  NO GIT, NO RENDER, BUT A PIN. Unknown is answered as unknown.
  {
    fs.rmSync(path.join(SCRATCH, ".git"), { recursive: true, force: true });
    const r = runScratch(MISSING_LAST, { ...RELEASE, EXPECTED_SHA: HEAD });
    ok_or(r.code === 1 && /CANNOT be verified here/.test(r.out),
      "NO BUILD IDENTITY: a pin that cannot be checked is REFUSED, not accepted", `exit=${r.code}`);
    ok_or(/never verified/.test(r.out),
      "NO BUILD IDENTITY: …and it says why, in the releaser's terms", r.out.slice(-400));
  }

  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

function ok_or(cond, label, detail) { cond ? ok(label) : bad(label, detail); }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
