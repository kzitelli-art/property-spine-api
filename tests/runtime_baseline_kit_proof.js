// ════════════════════════════════════════════════════════════════════
//  runtime_baseline_kit_proof.js — BASELINE INTAKE KIT proof harness
//
//    node tests/runtime_baseline_kit_proof.js
//
//  ── NO DATABASE. NO REAL DUMP. NO FAKE SPINE SCHEMA. ────────────────
//
//  Every artifact here is SYNTHETIC and deliberately unlike Property Spine —
//  a `widgets` table, a `gizmos` table, three-line ledgers. Manufacturing a
//  plausible copy of the production schema to test against would be the exact
//  thing this kit exists to avoid: a fabricated baseline that looks real
//  enough to be mistaken for one.
//
//  The shell scripts are exercised with STUB `pg_dump` and `psql` binaries
//  placed first on PATH. That proves the scripts' control flow — what they
//  refuse, what they clean up, what they print — without a database and
//  without credentials.
//
//  The verifier's judgment is tested directly against synthetic catalog
//  readings, which is why its analysis lives in a pure module.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const SCAN = require("../scripts/runtime-proof/baseline_scan");
const A = require("../scripts/runtime-proof/baseline_analysis");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

const KIT = path.join(__dirname, "..", "scripts", "runtime-proof");
const REPO = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-kit-proof-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

//  A connection string that exists only inside this harness. Every output the
//  scripts produce is searched for it.
const FAKE_URL = "postgresql://spine_export_user:tr0ub4dor-SECRET-3@db.example.invalid:5432/synthetic_db?sslmode=require";
const SECRET = "tr0ub4dor-SECRET-3";

// ── synthetic artifacts ─────────────────────────────────────────────
const CLEAN_SCHEMA = `--
-- synthetic schema-only dump. Nothing here resembles Property Spine.
--
SET statement_timeout = 0;
CREATE TABLE public.widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL
);
CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    name text NOT NULL,
    applied_at timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE ONLY public.widgets ADD CONSTRAINT widgets_pkey PRIMARY KEY (id);
`;

const DIRTY_SCHEMA = CLEAN_SCHEMA + `
COPY public.widgets (id, label) FROM stdin;
1\tone
\\.
INSERT INTO public.gizmos (id, owner_email) VALUES (1, 'someone@example.com');
CREATE FUNCTION public.owner_of() RETURNS uuid AS $$
  SELECT 'a3f1c2d4-5b6e-4a7c-8d9e-0f1a2b3c4d5e'::uuid;
$$ LANGUAGE sql;
CREATE VIEW public.hotline AS SELECT '+1 555-867-5309'::text AS number;
`;

const CLEAN_LEDGER = `--
-- synthetic ledger dump
--
INSERT INTO public.schema_migrations (version, name, applied_at) VALUES ('001', 'baseline', '2025-01-01 00:00:00+00');
INSERT INTO public.schema_migrations (version, name, applied_at) VALUES ('002', 'widgets', '2025-01-02 00:00:00+00');
INSERT INTO public.schema_migrations (version, name, applied_at) VALUES ('003', 'gizmos', '2025-01-03 00:00:00+00');
`;

const DIRTY_LEDGER = CLEAN_LEDGER +
`INSERT INTO public.widgets (id, label) VALUES (1, 'a real row that should not be here');
COPY public.people (id, email) FROM stdin;
1\tperson@example.com
\\.
`;

const w = (name, body) => { const p = path.join(TMP, name); fs.writeFileSync(p, body); return p; };
const CLEAN_SCHEMA_F = w("clean_schema.sql", CLEAN_SCHEMA);
const DIRTY_SCHEMA_F = w("dirty_schema.sql", DIRTY_SCHEMA);
const CLEAN_LEDGER_F = w("clean_ledger.sql", CLEAN_LEDGER);
const DIRTY_LEDGER_F = w("dirty_ledger.sql", DIRTY_LEDGER);

// ── stub PostgreSQL binaries ────────────────────────────────────────
//  Placed first on PATH. They never connect to anything; they read a control
//  file to decide whether to succeed, and they echo their own arguments into
//  a log so the harness can prove what the scripts asked for.
function stubDir({ pgDumpMode = "ok", psqlValues = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, "bin-"));
  const log = path.join(dir, "calls.log");

  fs.writeFileSync(path.join(dir, "pg_dump"), `#!/usr/bin/env bash
echo "pg_dump $*" >> "${log}"
case "${pgDumpMode}" in
  ok)
    if [[ "$*" == *"--data-only"* ]]; then cat "${CLEAN_LEDGER_F}"; else cat "${CLEAN_SCHEMA_F}"; fi
    exit 0 ;;
  fail-ledger)
    if [[ "$*" == *"--data-only"* ]]; then
      # A REAL pg_dump failure quotes the connection string back at you.
      echo "pg_dump: error: connection to server failed for \\"$*\\"" >&2
      exit 1
    fi
    cat "${CLEAN_SCHEMA_F}"; exit 0 ;;
  fail-schema)
    echo "pg_dump: error: could not connect using \\"$*\\"" >&2
    exit 1 ;;
esac
`, { mode: 0o755 });

  const v = Object.assign({
    server_version: "16.3",
    current_database: "spine_baseline_scratch",
    table_count: "0",
    ledger_count: "3",
  }, psqlValues);

  fs.writeFileSync(path.join(dir, "psql"), `#!/usr/bin/env bash
echo "psql $*" >> "${log}"
ARGS="$*"
if [[ "$ARGS" == *"show server_version"* ]]; then echo "${v.server_version}"; exit 0; fi
if [[ "$ARGS" == *"current_database"* ]];  then echo "${v.current_database}"; exit 0; fi
if [[ "$ARGS" == *"information_schema.tables"* ]]; then echo "${v.table_count}"; exit 0; fi
if [[ "$ARGS" == *"count(*) from public.schema_migrations"* ]]; then echo "${v.ledger_count}"; exit 0; fi
if [[ "$ARGS" == *"-f"* ]]; then exit 0; fi
exit 0
`, { mode: 0o755 });

  return { dir, log };
}

function run(script, args, { env = {}, bin = null } = {}) {
  const PATH = (bin ? bin.dir + path.delimiter : "") + process.env.PATH;
  const r = spawnSync("bash", [path.join(KIT, script), ...args], {
    env: Object.assign({}, process.env, { PATH }, env),
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "", all: (r.stdout || "") + (r.stderr || "") };
}

const OUT = () => {
  const d = fs.mkdtempSync(path.join(TMP, "out-"));
  return {
    dir: d,
    schema: path.join(d, "spine_schema_baseline.sql"),
    ledger: path.join(d, "spine_schema_migrations.sql"),
    manifest: path.join(d, "manifest.txt"),
  };
};

// ════════════════════════════════════════════════════════════════════
section("1  a failed export leaves NO partial artifacts behind");
{
  const bin = stubDir({ pgDumpMode: "fail-ledger" });
  const o = OUT();
  const r = run("export-baseline.sh", ["--out-dir", o.dir], { env: { DATABASE_URL: FAKE_URL }, bin });

  ok("the export exits non-zero", r.code !== 0, String(r.code));
  ok("the schema artifact is deleted", !fs.existsSync(o.schema));
  ok("the ledger artifact is deleted", !fs.existsSync(o.ledger));
  ok("the manifest is deleted", !fs.existsSync(o.manifest));
  ok("it says both were removed", /deleted/i.test(r.all));
  ok("and says why two moments would be wrong", /never existed/i.test(r.all));

  // The schema DID succeed first — proving the cleanup is not just "nothing
  // was ever written".
  ok("the schema dump had in fact been produced first", /pg_dump.*--schema-only/.test(fs.readFileSync(bin.log, "utf8")));

  const bin2 = stubDir({ pgDumpMode: "fail-schema" });
  const o2 = OUT();
  const r2 = run("export-baseline.sh", ["--out-dir", o2.dir], { env: { DATABASE_URL: FAKE_URL }, bin: bin2 });
  ok("a first-step failure also exits non-zero", r2.code !== 0);
  ok("and leaves nothing behind",
     !fs.existsSync(o2.schema) && !fs.existsSync(o2.ledger) && !fs.existsSync(o2.manifest));
}

// ════════════════════════════════════════════════════════════════════
section("2  credentials are never printed, written, or accepted as an argument");
{
  const bin = stubDir();
  const o = OUT();
  const r = run("export-baseline.sh", ["--out-dir", o.dir], { env: { DATABASE_URL: FAKE_URL }, bin });
  ok("a clean export succeeds", r.code === 0, r.all.slice(-400));

  ok("the password never appears in stdout", !r.out.includes(SECRET));
  ok("the password never appears in stderr", !r.err.includes(SECRET));
  ok("the whole connection string never appears in output", !r.all.includes(FAKE_URL));
  ok("nor the host and user", !r.all.includes("spine_export_user"));

  const manifest = fs.readFileSync(o.manifest, "utf8");
  ok("the manifest carries no password", !manifest.includes(SECRET));
  ok("the manifest carries no connection string", !manifest.includes(FAKE_URL));
  ok("the manifest has no url-shaped text at all", !/[a-z]+:\/\//i.test(manifest));
  for (const f of [o.schema, o.ledger]) {
    const t = fs.readFileSync(f, "utf8");
    ok(`${path.basename(f)} carries no password`, !t.includes(SECRET));
  }

  // A FAILING export is where a URL normally escapes, via the tool's own error.
  const binF = stubDir({ pgDumpMode: "fail-schema" });
  const oF = OUT();
  const rF = run("export-baseline.sh", ["--out-dir", oF.dir], { env: { DATABASE_URL: FAKE_URL }, bin: binF });
  ok("a failing export does not leak the password in its error", !rF.all.includes(SECRET));
  ok("and the leaked string is visibly redacted", /redacted/i.test(rF.all));

  // Refuses a connection string on the command line.
  const rArg = run("export-baseline.sh", [FAKE_URL], { env: { DATABASE_URL: FAKE_URL }, bin });
  ok("a connection-string argument is refused", rArg.code !== 0);
  ok("and the refusal explains shell history", /shell history/i.test(rArg.all));
  ok("the refusal does not echo the password back", !rArg.all.includes(SECRET));

  // Without DATABASE_URL it does not connect at all.
  const binN = stubDir();
  const rNo = run("export-baseline.sh", ["--out-dir", OUT().dir], { env: { DATABASE_URL: "" }, bin: binN });
  ok("no DATABASE_URL means no export", rNo.code !== 0);
  ok("and nothing was ever invoked", !fs.existsSync(binN.log));
}

// ════════════════════════════════════════════════════════════════════
section("3  table data in a schema-only dump is flagged");
{
  const s = SCAN.scanSchemaDump(DIRTY_SCHEMA);
  const codes = s.warnings.map((x) => x.code);
  ok("a COPY block is flagged", codes.includes("data_statement_in_schema_dump"));
  ok("an INSERT is flagged too",
     s.warnings.some((x) => x.code === "data_statement_in_schema_dump" && /insert into/i.test(x.detail)));
  ok("a UUID literal inside a function body is flagged", codes.includes("uuid_literal_in_logic"));
  ok("and it names the function body", s.warnings.some((x) => /function body/.test(x.detail)));
  ok("a phone-shaped literal in a view is flagged", codes.includes("phone_literal"));
  ok("an email-shaped literal is flagged", codes.includes("email_literal"));
  ok("warnings carry a line number", s.warnings.some((x) => typeof x.line === "number"));

  const clean = SCAN.scanSchemaDump(CLEAN_SCHEMA);
  ok("a clean schema dump raises nothing", clean.warnings.length === 0,
     clean.warnings.map((x) => x.code).join(","));
  ok("gen_random_uuid() is not mistaken for a literal",
     !clean.warnings.some((x) => x.code === "uuid_literal_in_logic"));

  // The scan NEVER mutates the artifact.
  const before = fs.readFileSync(DIRTY_SCHEMA_F, "utf8");
  execFileSync("node", [path.join(KIT, "inspect-artifacts.js"),
    "--schema", DIRTY_SCHEMA_F, "--ledger", CLEAN_LEDGER_F], { encoding: "utf8" });
  ok("the artifact is byte-identical after inspection",
     fs.readFileSync(DIRTY_SCHEMA_F, "utf8") === before);

  const rep = JSON.parse(execFileSync("node", [path.join(KIT, "inspect-artifacts.js"),
    "--schema", DIRTY_SCHEMA_F, "--ledger", CLEAN_LEDGER_F], { encoding: "utf8" }));
  ok("the report refuses to claim the artifact is safe",
     /does not prove/i.test(rep.disclaimer));
  ok("warnings do not fail the inspection", rep.warning_count > 0);

  // And the export surfaces them to the owner rather than exiting.
  const bin = stubDir();
  const o = OUT();
  fs.writeFileSync(path.join(bin.dir, "pg_dump"), `#!/usr/bin/env bash
if [[ "$*" == *"--data-only"* ]]; then cat "${CLEAN_LEDGER_F}"; else cat "${DIRTY_SCHEMA_F}"; fi
exit 0
`, { mode: 0o755 });
  const r = run("export-baseline.sh", ["--out-dir", o.dir], { env: { DATABASE_URL: FAKE_URL }, bin });
  ok("a dirty export still completes", r.code === 0, r.all.slice(-300));
  ok("but the owner is shown warnings", /warning\(s\)/i.test(r.all));
  ok("and told nothing was changed", /NOTHING HAS BEEN CHANGED/i.test(r.all));
  ok("and told the scan is not a guarantee", /not a guarantee/i.test(r.all));
  ok("the manifest records the warning count",
     /inspection_warnings\s+[1-9]/.test(fs.readFileSync(o.manifest, "utf8")));
}

// ════════════════════════════════════════════════════════════════════
section("4  non-ledger data in the ledger artifact is flagged");
{
  const d = SCAN.scanLedgerDump(DIRTY_LEDGER);
  const codes = d.warnings.map((x) => x.code);
  ok("an INSERT into another table is flagged", codes.includes("non_ledger_table_data"));
  ok("and it names the offending table", d.warnings.some((x) => /widgets/.test(x.detail)));
  ok("a COPY of another table is flagged too", d.warnings.some((x) => /people/.test(x.detail)));
  ok("an email in a ledger artifact is flagged", codes.includes("email_literal"));
  ok("the tables it saw are reported", d.tables.some((t) => /widgets/.test(t)));

  const c = SCAN.scanLedgerDump(CLEAN_LEDGER);
  ok("a clean ledger raises nothing", c.warnings.length === 0, c.warnings.map((x) => x.code).join(","));
  ok("and schema_migrations is not treated as foreign",
     c.tables.every((t) => /schema_migrations$/.test(t)));

  const facts = SCAN.ledgerFacts(CLEAN_LEDGER);
  ok("ledger rows are counted from the artifact", facts.rows === 3, String(facts.rows));
  ok("the highest identifier is read from the artifact", facts.highest === "003", facts.highest);
  ok("a COPY-form ledger is understood too",
     SCAN.ledgerFacts("COPY public.schema_migrations (version, name) FROM stdin;\n007\tseven\n\\.\n").rows === 1);
}

// ════════════════════════════════════════════════════════════════════
section("5  restore refuses a target that already has tables");
{
  const bin = stubDir({ psqlValues: { table_count: "42", current_database: "scratch_db" } });
  const r = run("restore-baseline.sh",
    ["--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F, "--disposable-database"],
    { env: { TARGET_DATABASE_URL: FAKE_URL }, bin });

  ok("it refuses", r.code !== 0, String(r.code));
  ok("and says how many tables it found", /42 table/.test(r.all));
  ok("it never dropped anything", !/drop/i.test(r.all.replace(/does not drop[^.]*\./i, "")));
  ok("it states it will not drop, truncate or recreate", /does not drop, truncate or recreate/i.test(r.all));
  ok("no restore was attempted", !/-f /.test(fs.readFileSync(bin.log, "utf8")));
  ok("the target url is not printed", !r.all.includes(SECRET) && !r.all.includes(FAKE_URL));

  // A production-shaped name is refused even when empty.
  for (const name of ["production", "spine_prod", "live", "app-prod"]) {
    const b = stubDir({ psqlValues: { table_count: "0", current_database: name } });
    const rr = run("restore-baseline.sh",
      ["--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F, "--disposable-database"],
      { env: { TARGET_DATABASE_URL: FAKE_URL }, bin: b });
    ok(`a database named "${name}" is refused`, rr.code !== 0, rr.all.slice(-200));
    ok("and the refusal names it", rr.all.includes(name));
  }

  // The happy path still works, in the right order.
  const okBin = stubDir({ psqlValues: { table_count: "0", current_database: "spine_baseline_scratch" } });
  const rr = run("restore-baseline.sh",
    ["--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F, "--disposable-database"],
    { env: { TARGET_DATABASE_URL: FAKE_URL }, bin: okBin });
  ok("an empty, disposable-named target restores", rr.code === 0, rr.all.slice(-300));
  const calls = fs.readFileSync(okBin.log, "utf8");
  ok("the schema is loaded before the ledger",
     calls.indexOf(CLEAN_SCHEMA_F) < calls.indexOf(CLEAN_LEDGER_F));
  ok("and the target url never appears in output", !rr.all.includes(SECRET));
}

// ════════════════════════════════════════════════════════════════════
section("6  restore refuses without the disposable flag");
{
  const bin = stubDir({ psqlValues: { table_count: "0" } });
  const r = run("restore-baseline.sh",
    ["--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F],
    { env: { TARGET_DATABASE_URL: FAKE_URL }, bin });

  ok("it refuses", r.code !== 0, String(r.code));
  ok("and names the flag", /--disposable-database/.test(r.all));
  ok("it says the flag is not defaulted", /not defaulted/i.test(r.all));
  ok("it did not even connect", !fs.existsSync(bin.log));
}

// ════════════════════════════════════════════════════════════════════
section("7  the verifier detects ledger/object disagreement");
{
  const present = ["properties", "units", "schema_migrations"];
  const cols = { unit_triage_required_work: ["id", "stage", "stage_decision_required", "stage_decision_note"] };

  // RECORDED, objects ABSENT — the runner would skip it forever.
  const a = A.analyseBuildMigrations({
    ledgerRows: [{ version: "112", name: "unit_triage_capture" }],
    tables: present, columnsByTable: {},
  });
  const m112 = a.migrations.find((m) => m.version === "112");
  ok("recorded-but-absent is detected", m112.verdict === "recorded_without_objects", m112.verdict);
  ok("and it lists the missing tables", m112.missing_tables.length === 4, String(m112.missing_tables.length));
  ok("the overall verdict is disagreement", a.agrees === false);
  ok("112 is NOT reported as pending", !a.pending.includes("112"));

  // OBJECTS PRESENT, ledger silent — the runner would try it again.
  const b = A.analyseBuildMigrations({
    ledgerRows: [],
    tables: present.concat(["staff_agent_threads", "staff_agent_messages", "staff_agent_proposals"]),
    columnsByTable: {},
  });
  const m117 = b.migrations.find((m) => m.version === "117");
  ok("objects-without-ledger is detected", m117.verdict === "objects_without_ledger", m117.verdict);
  ok("that also counts as disagreement", b.agrees === false);
  ok("and it is not called pending", !b.pending.includes("117"));

  // A column-only migration is judged on its columns.
  const c = A.analyseBuildMigrations({
    ledgerRows: [{ version: "114", name: "inherited_work_stage_decision" }],
    tables: present, columnsByTable: cols,
  });
  ok("a column-only migration verifies through its columns",
     c.migrations.find((m) => m.version === "114").verdict === "applied_and_recorded");
  const c2 = A.analyseBuildMigrations({
    ledgerRows: [{ version: "114", name: "inherited_work_stage_decision" }],
    tables: present, columnsByTable: { unit_triage_required_work: ["id"] },
  });
  ok("and a missing column is caught",
     c2.migrations.find((m) => m.version === "114").verdict === "recorded_without_objects");

  // NEITHER — genuinely pending, and that is not an error.
  const d = A.analyseBuildMigrations({ ledgerRows: [], tables: present, columnsByTable: {} });
  ok("neither recorded nor present is 'pending'", d.pending.length === 6, d.pending.join(","));
  ok("and pending is NOT a disagreement", d.agrees === true);

  // A label mismatch is reported without being escalated.
  const e = A.analyseBuildMigrations({
    ledgerRows: [{ version: "117", name: "something_else" }],
    tables: present.concat(["staff_agent_threads", "staff_agent_messages", "staff_agent_proposals"]),
    columnsByTable: {},
  });
  ok("a differing ledger label is reported",
     e.migrations.find((m) => m.version === "117").name_matches === false);

  // NOTHING IS REPAIRED.
  const VSRC = fs.readFileSync(path.join(KIT, "verify-baseline.js"), "utf8");
  const ASRC = fs.readFileSync(path.join(KIT, "baseline_analysis.js"), "utf8");
  for (const [name, src] of [["the verifier", VSRC], ["the analysis module", ASRC]]) {
    ok(`${name} issues no INSERT`, !/insert\s+into/i.test(src));
    ok(`${name} issues no UPDATE`, !/update\s+\w+\s+set/i.test(src));
    ok(`${name} issues no DELETE`, !/delete\s+from/i.test(src));
    ok(`${name} issues no CREATE or ALTER or DROP`,
       !/\b(create|alter|drop)\s+(table|type|index|view|function|schema)\b/i.test(src));
  }
  ok("the verifier opens a READ ONLY transaction", /begin transaction read only/i.test(VSRC));
}

// ════════════════════════════════════════════════════════════════════
section("8  the verifier detects a migration-number collision");
{
  // Something else already spent 114.
  const c = A.analyseCollisions({
    ledgerRows: [{ version: "114", name: "some_other_thing" }],
    migrationFiles: ["113_unit_turn_scope.sql", "114_inherited_work_stage_decision.sql"],
  });
  ok("a spent number is detected", c.number_already_spent.length === 1);
  ok("it names both sides",
     c.number_already_spent[0].ledger_says === "some_other_thing" &&
     /114_inherited/.test(c.number_already_spent[0].folder_has));
  ok("it states the consequence", /never run/.test(c.number_already_spent[0].consequence));
  ok("and it is scoped as a Build collision", c.build_collisions.length === 1);
  ok("the result is not clean", c.clean === false);

  // Two files sharing a number.
  const d = A.analyseCollisions({
    ledgerRows: [],
    migrationFiles: ["094_a.sql", "094_b.sql"],
  });
  ok("duplicate files are detected", d.duplicate_files.length === 1, JSON.stringify(d.duplicate_files));
  ok("and both filenames are named", d.duplicate_files[0].files.length === 2);

  // The runner's own name normalisation is honoured, not second-guessed.
  const e = A.analyseCollisions({
    ledgerRows: [{ version: "112", name: "112_unit_triage_capture.sql" }],
    migrationFiles: ["112_unit_triage_capture.sql"],
  });
  ok("a full filename in the ledger is not a collision", e.clean === true, JSON.stringify(e));
  const f = A.analyseCollisions({
    ledgerRows: [{ version: "112", name: "unit_triage_capture (1)" }],
    migrationFiles: ["112_unit_triage_capture.sql"],
  });
  ok("a duplicated-download name is not a collision", f.clean === true);

  // The real folder against a ledger that stops at 111 — the expected shape.
  const real = fs.readdirSync(path.join(REPO, "migrations")).filter((x) => /^\d{3}_.*\.sql$/.test(x));
  const upTo111 = real.filter((x) => Number(x.slice(0, 3)) <= 111)
    .map((x) => ({ version: x.slice(0, 3), name: x.slice(4, -4) }));
  const g = A.analyseCollisions({ ledgerRows: upTo111, migrationFiles: real });
  ok("the repository's own files collide with nothing under that ledger", g.clean === true,
     JSON.stringify(g.number_already_spent.concat(g.duplicate_files)));

  const p = A.analysePendingApplication({ ledgerRows: upTo111, migrationFiles: real });
  ok("exactly the six Build migrations would be pending", p.pending_build.length === 6, p.pending_build.join(","));
  ok("nothing outside Builds 1-5 would be pending", p.pending_other.length === 0, p.pending_other.join(","));
  ok("and that is reported as safe to run", p.safe_to_run === true);
}

// ════════════════════════════════════════════════════════════════════
section("9  the pending runner refuses mismatches");
{
  // An incomplete ledger means the runner would reach into the historical chain.
  const real = fs.readdirSync(path.join(REPO, "migrations")).filter((x) => /^\d{3}_.*\.sql$/.test(x));
  const missingEarly = real.filter((x) => Number(x.slice(0, 3)) <= 111 && x.slice(0, 3) !== "087")
    .map((x) => ({ version: x.slice(0, 3), name: x.slice(4, -4) }));
  const p = A.analysePendingApplication({ ledgerRows: missingEarly, migrationFiles: real });
  ok("a pending historical migration makes it unsafe", p.safe_to_run === false);
  ok("and 087 is named as the reason", /087/.test(p.reason), p.reason);
  ok("the reason explains the runner applies everything", /EVERY pending migration/.test(p.reason));

  ok("nothing pending at all is also not 'safe to run'",
     A.analysePendingApplication({
       ledgerRows: real.map((x) => ({ version: x.slice(0, 3), name: x.slice(4, -4) })),
       migrationFiles: real,
     }).safe_to_run === false);

  // The script's own control flow.
  const SRC = fs.readFileSync(path.join(KIT, "apply-pending-build-migrations.sh"), "utf8");
  ok("it runs the verifier first",
     SRC.indexOf("verify-baseline.js") < SRC.indexOf("migrations/migrate.js"));
  ok("it exits when the verifier fails", /verify-baseline\.js[\s\S]{0,400}Nothing will be applied/.test(SRC));
  ok("it refuses on a Build collision", /COLLISIONS.*!=.*"0"|\[ "\$COLLISIONS" != "0" \]/.test(SRC));
  ok("it refuses when safe_to_run is false", /\[ "\$SAFE" != "true" \]/.test(SRC));
  ok("it requires an explicit --apply", /\[ "\$APPLY" -ne 1 \]/.test(SRC));
  ok("without it, the run is a dry run", /DRY RUN/.test(SRC));
  ok("it shows the exact files that would run", /PENDING_BUILD/.test(SRC));
  ok("it refuses to renumber anything", /Renumbering is NOT done automatically/i.test(SRC));

  // IT DOES NOT REIMPLEMENT SQL EXECUTION.
  ok("it invokes the repository's own runner", /node "\$REPO_ROOT\/migrations\/migrate\.js"/.test(SRC));
  ok("it executes no SQL itself",
     !/\bpsql\b/.test(SRC) && !/create table|alter table|insert into/i.test(SRC));

  // Without a target it will not even start.
  const r = run("apply-pending-build-migrations.sh", ["--apply"], { env: { TARGET_DATABASE_URL: "" } });
  ok("no target means no run", r.code !== 0);
  ok("and it says so plainly", /No target database/.test(r.all));
}

// ════════════════════════════════════════════════════════════════════
section("10  the kit touches no migration and no application source");
{
  const { execSync } = require("child_process");
  const changed = execSync("git diff --name-only a269fce", { cwd: REPO }).toString()
    .trim().split("\n").filter(Boolean);
  const untracked = execSync("git ls-files --others --exclude-standard", { cwd: REPO }).toString()
    .trim().split("\n").filter(Boolean);
  const all = changed.concat(untracked);

  ok("no migration file was touched", !all.some((f) => f.startsWith("migrations/")), all.join(","));
  ok("no application source was touched", !all.some((f) => f.startsWith("src/")), all.join(","));
  ok("server.js was not touched", !all.includes("server.js"));
  ok("package.json was not touched", !all.includes("package.json"));

  const ALLOWED = /^(scripts\/runtime-proof\/|docs\/RUNTIME_BASELINE_HANDOFF\.md$|runtime-proof-artifacts\/\.gitkeep$|tests\/runtime_baseline_kit_proof\.js$|\.gitignore$)/;
  const unexpected = all.filter((f) => !ALLOWED.test(f));
  ok("only kit files, the doc, the harness and .gitignore changed",
     unexpected.length === 0, unexpected.join(","));

  // No script writes into migrations/ or src/.
  for (const f of fs.readdirSync(KIT)) {
    const src = fs.readFileSync(path.join(KIT, f), "utf8");
    ok(`${f} never writes into migrations/`,
       !/(>|>>|writeFileSync|renameSync|unlinkSync|rm |mv |cp )[^\n]*migrations\//.test(src));
    ok(`${f} never writes into src/`,
       !/(>|>>|writeFileSync|renameSync|unlinkSync|rm |mv |cp )[^\n]*\bsrc\//.test(src));
  }

  // .gitignore ignores EXACTLY the artifact directory, and no .sql globally.
  const gi = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
  ok("the artifact directory is ignored", /^\/runtime-proof-artifacts\/\*$/m.test(gi));
  ok("the .gitkeep is kept", /^!\/runtime-proof-artifacts\/\.gitkeep$/m.test(gi));
  ok("no broad .sql ignore was added", !/^\**\.sql$/m.test(gi) && !/\*\.sql/.test(gi));
  ok("migrations are still tracked",
     execSync("git ls-files migrations/ | wc -l", { cwd: REPO }).toString().trim() !== "0");

  // A real dump can never be committed by accident.
  const probe = path.join(REPO, "runtime-proof-artifacts", "spine_schema_baseline.sql");
  fs.writeFileSync(probe, "-- synthetic probe, deleted immediately\n");
  const ignored = spawnSync("git", ["check-ignore", "-q", probe], { cwd: REPO }).status === 0;
  fs.unlinkSync(probe);
  ok("an artifact placed in the directory is git-ignored", ignored);
  ok("a migration file is NOT ignored",
     spawnSync("git", ["check-ignore", "-q", "migrations/112_unit_triage_capture.sql"], { cwd: REPO }).status !== 0);
}

// ════════════════════════════════════════════════════════════════════
section("11  the documentation states the boundaries");
{
  const DOC = fs.readFileSync(path.join(REPO, "docs", "RUNTIME_BASELINE_HANDOFF.md"), "utf8");
  const must = [
    [/never (be )?commit/i, "artifacts must never be committed"],
    [/schema-only except for the migration ledger|schema only.*except.*ledger/i, "the dump is schema-only except the ledger"],
    [/same (database and )?invocation/i, "both artifacts come from the same invocation"],
    [/does not repair migrations 001[–-]087/i, "this does not repair 001-087"],
    [/does not make builds? 1[–-]6b live|not make .* live/i, "this does not make any Build live"],
    [/never send the database url|do not send .*database_url/i, "the owner never sends the URL"],
  ];
  for (const [re, what] of must) ok(`the doc states: ${what}`, re.test(DOC));
  ok("it contains an owner workflow", /owner workflow/i.test(DOC));
  ok("it contains a developer workflow", /developer workflow/i.test(DOC));
  ok("it gives the exact export command", /export-baseline\.sh/.test(DOC));
  ok("it gives the exact restore command", /restore-baseline\.sh/.test(DOC));
  ok("it gives the exact verify command", /verify-baseline\.js/.test(DOC));
  ok("it tells the developer to verify checksums", /sha256|checksum/i.test(DOC));
  ok("it refuses to call the scan a guarantee", /not (a )?guarantee|does not prove/i.test(DOC));
}

// ════════════════════════════════════════════════════════════════════
section("12  LIVE — the scripts against a real, disposable PostgreSQL");
//
//  Optional, and VISIBLY SKIPPED when it cannot run rather than quietly
//  counted as green. Set KIT_PROOF_ADMIN_URL to a superuser connection on a
//  THROWAWAY cluster; the section creates and drops its own databases.
//
//  Everything loaded is the same synthetic `widgets` schema used above. No
//  Property Spine schema is manufactured, and nothing here proves anything
//  about a real baseline — it proves the scripts do what they claim when a
//  database is actually on the other end.
{
  const ADMIN = process.env.KIT_PROOF_ADMIN_URL || "";
  if (!ADMIN) {
    console.log("     SKIPPED — KIT_PROOF_ADMIN_URL is not set.");
    console.log("     The stub-binary sections above prove control flow. They do NOT");
    console.log("     prove the scripts work against a real server. That is unproven");
    console.log("     in this run, and is being said rather than left implied.");
    ok("the live section was explicitly skipped, not silently passed", true);
  } else {
    const psql = (db, sql, extra = []) => spawnSync("psql", [
      "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1", ...extra, "-c", sql, urlFor(db),
    ], { encoding: "utf8" });
    const urlFor = (db) => ADMIN.replace(/\/[^/?]*(\?|$)/, `/${db}$1`);
    const drop = (db) => spawnSync("psql", ["-X", "-q", "-c", `drop database if exists ${db}`, ADMIN], { encoding: "utf8" });
    const create = (db) => spawnSync("psql", ["-X", "-q", "-c", `create database ${db}`, ADMIN], { encoding: "utf8" });

    const SCRATCH = "spine_baseline_scratch";
    const PRODISH = "production";
    const SOURCE = "kit_proof_source";
    for (const db of [SCRATCH, PRODISH, SOURCE]) drop(db);

    // ── A REAL EXPORT, with the real pg_dump ────────────────────────
    //  A synthetic source database stands in for the owner's. The point is
    //  that export-baseline.sh drives an actual pg_dump and produces
    //  artifacts that actually restore — not that this schema resembles
    //  anything.
    create(SOURCE);
    spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", CLEAN_SCHEMA_F, urlFor(SOURCE)]);
    spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", CLEAN_LEDGER_F, urlFor(SOURCE)]);

    const eOut = fs.mkdtempSync(path.join(TMP, "live-out-"));
    const e = spawnSync("bash", [path.join(KIT, "export-baseline.sh"), "--out-dir", eOut],
      { env: Object.assign({}, process.env, { DATABASE_URL: urlFor(SOURCE) }), encoding: "utf8" });
    const eAll = (e.stdout || "") + (e.stderr || "");
    ok("a real export succeeds against a real database", e.status === 0, eAll.slice(-500));

    const eSchema = path.join(eOut, "spine_schema_baseline.sql");
    const eLedger = path.join(eOut, "spine_schema_migrations.sql");
    const eManifest = path.join(eOut, "manifest.txt");
    ok("it produced the schema artifact", fs.existsSync(eSchema));
    ok("it produced the ledger artifact", fs.existsSync(eLedger));
    ok("it produced the manifest", fs.existsSync(eManifest));

    const eSchemaText = fs.readFileSync(eSchema, "utf8");
    const eLedgerText = fs.readFileSync(eLedger, "utf8");
    const eManText = fs.readFileSync(eManifest, "utf8");

    ok("the real schema dump carries no table data",
       SCAN.scanSchemaDump(eSchemaText).warnings
         .filter((x) => x.code === "data_statement_in_schema_dump").length === 0);
    ok("the real ledger dump carries only schema_migrations",
       SCAN.scanLedgerDump(eLedgerText).warnings
         .filter((x) => x.code === "non_ledger_table_data").length === 0);
    ok("the real ledger dump has the three rows", SCAN.ledgerFacts(eLedgerText).rows === 3);

    ok("the manifest's schema checksum matches the file",
       eManText.includes(SCAN.sha256(eSchemaText)));
    ok("the manifest's ledger checksum matches the file",
       eManText.includes(SCAN.sha256(eLedgerText)));
    ok("the manifest records the real server version", /server_version\s+\d+/.test(eManText));
    ok("the manifest records the database name", new RegExp(`database_name\\s+${SOURCE}`).test(eManText));
    ok("the manifest records the highest ledger identifier", /ledger_highest\s+003/.test(eManText));
    ok("the manifest records a git sha", /script_git_sha\s+[0-9a-f]{7,}/.test(eManText));
    ok("the manifest contains no connection string", !/[a-z]+:\/\//i.test(eManText));
    ok("the export output contains no connection string", !eAll.includes(urlFor(SOURCE)));

    // The artifacts it produced are the ones the rest of the pipeline consumes.
    const eScratch = "kit_proof_roundtrip";
    drop(eScratch); create(eScratch);
    const rt = spawnSync("bash", [path.join(KIT, "restore-baseline.sh"),
      "--schema", eSchema, "--ledger", eLedger, "--disposable-database"],
      { env: Object.assign({}, process.env, { TARGET_DATABASE_URL: urlFor(eScratch) }), encoding: "utf8" });
    ok("the exported artifacts restore into a fresh database", rt.status === 0,
       ((rt.stdout || "") + (rt.stderr || "")).slice(-400));
    ok("and the round-tripped ledger has the same three rows",
       psql(eScratch, "select count(*) from public.schema_migrations").stdout.trim() === "3");
    drop(eScratch); drop(SOURCE);

    ok("a disposable database can be created", create(SCRATCH).status === 0);

    // ── the real restore, on a real empty database ──
    const r = spawnSync("bash", [path.join(KIT, "restore-baseline.sh"),
      "--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F, "--disposable-database"],
      { env: Object.assign({}, process.env, { TARGET_DATABASE_URL: urlFor(SCRATCH) }), encoding: "utf8" });
    ok("the restore succeeds against a real empty database", r.status === 0,
       ((r.stdout || "") + (r.stderr || "")).slice(-400));
    ok("it reports the ledger rows it loaded", /3 ledger row/.test(r.stdout || ""));

    const rows = psql(SCRATCH, "select count(*) from public.schema_migrations").stdout.trim();
    ok("the ledger really is in the database", rows === "3", rows);
    const tbls = psql(SCRATCH, "select count(*) from information_schema.tables where table_schema='public'").stdout.trim();
    ok("and the schema really is too", Number(tbls) >= 2, tbls);

    // ── refusing a database that is no longer empty. NOT a stub this time. ──
    const r2 = spawnSync("bash", [path.join(KIT, "restore-baseline.sh"),
      "--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F, "--disposable-database"],
      { env: Object.assign({}, process.env, { TARGET_DATABASE_URL: urlFor(SCRATCH) }), encoding: "utf8" });
    ok("a second restore into the same database is refused", r2.status !== 0);
    ok("because it now contains tables", /already contains \d+ table/.test((r2.stdout || "") + (r2.stderr || "")));
    ok("the ledger was not touched by the refusal",
       psql(SCRATCH, "select count(*) from public.schema_migrations").stdout.trim() === "3");

    // ── refusing a production-shaped name, for real ──
    create(PRODISH);
    const r3 = spawnSync("bash", [path.join(KIT, "restore-baseline.sh"),
      "--schema", CLEAN_SCHEMA_F, "--ledger", CLEAN_LEDGER_F, "--disposable-database"],
      { env: Object.assign({}, process.env, { TARGET_DATABASE_URL: urlFor(PRODISH) }), encoding: "utf8" });
    ok("an empty database named 'production' is still refused", r3.status !== 0);
    ok("and nothing was created in it",
       psql(PRODISH, "select count(*) from information_schema.tables where table_schema='public'").stdout.trim() === "0");
    drop(PRODISH);

    // ── the verifier against a real catalog ──
    const reportPath = path.join(TMP, "live-report.json");
    const v = spawnSync("node", [path.join(KIT, "verify-baseline.js"), "--json", reportPath],
      { env: Object.assign({}, process.env, { TARGET_DATABASE_URL: urlFor(SCRATCH) }), encoding: "utf8" });
    const vAll = (v.stdout || "") + (v.stderr || "");
    ok("the verifier runs against a real database", fs.existsSync(reportPath), vAll.slice(-400));
    const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));

    ok("it read the real ledger", rep.ledger.count === 3 && rep.ledger.highest === "003",
       JSON.stringify(rep.ledger).slice(0, 120));
    ok("it found no duplicates", rep.ledger.duplicates.length === 0);
    ok("it correctly reports the synthetic database as lacking the foundations",
       rep.foundations.satisfied === false);
    ok("and names properties and units among the missing",
       rep.foundations.missing_tables.includes("properties") &&
       rep.foundations.missing_tables.includes("units"));
    ok("it does NOT claim schema_migrations is missing",
       !rep.foundations.missing_tables.includes("schema_migrations"));
    ok("all six Build migrations read as pending", rep.build_migrations.pending.length === 6,
       rep.build_migrations.pending.join(","));
    ok("with no ledger/object disagreement", rep.build_migrations.agrees === true);
    ok("the synthetic ledger's names collide with the repository's files",
       rep.collisions.number_already_spent.some((c) => c.version === "002"),
       JSON.stringify(rep.collisions.number_already_spent).slice(0, 160));
    ok("applying is reported as unsafe", rep.pending_application.safe_to_run === false);
    ok("the overall verdict needs a human", rep.verdict === "needs_human", rep.verdict);
    ok("the verifier exits 1 on disagreement", v.status === 1, String(v.status));
    ok("the report says it is not runtime proof", /not runtime proof/i.test(rep.scope_note));
    ok("the target url never appears in the verifier's output",
       !vAll.includes(ADMIN) && !vAll.includes(SCRATCH + "?"));

    // ── the pending runner refuses, for real ──
    const a = spawnSync("bash", [path.join(KIT, "apply-pending-build-migrations.sh"), "--apply"],
      { env: Object.assign({}, process.env, { TARGET_DATABASE_URL: urlFor(SCRATCH) }), encoding: "utf8" });
    const aAll = (a.stdout || "") + (a.stderr || "");
    ok("the pending runner refuses when the verifier fails", a.status !== 0);
    ok("and says nothing will be applied", /Nothing will be applied/.test(aAll));
    ok("the migration runner was never reached", !/migrations\/migrate\.js\n/.test(a.stdout || ""));
    ok("no migration was recorded",
       psql(SCRATCH, "select count(*) from public.schema_migrations").stdout.trim() === "3");

    for (const db of [SCRATCH, PRODISH]) drop(db);
    ok("the disposable databases are cleaned up", true);
  }
}

// ════════════════════════════════════════════════════════════════════
section("RESULT");
console.log("  assertions passed: " + passed);
console.log("  assertions failed: " + failed);
if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
console.log("");
if (process.env.KIT_PROOF_ADMIN_URL) {
  console.log("  PROOF LEVEL: the scripts are exercised BOTH ways.");
  console.log("    · control flow, refusals, cleanup and redaction against stub");
  console.log("      pg_dump/psql binaries");
  console.log("    · a real export, restore, verify and refusal against a REAL, throwaway");
  console.log("      PostgreSQL server — including an export→restore round trip");
  console.log("");
  console.log("  Every artifact used was SYNTHETIC. No Property Spine schema was");
  console.log("  manufactured, and no real database was contacted.");
} else {
  console.log("  PROOF LEVEL: control flow only. Refusals, cleanup and redaction run for");
  console.log("  real, against stub pg_dump/psql binaries and synthetic artifacts.");
  console.log("");
  console.log("  The live section did NOT run. That a real export succeeds and a real");
  console.log("  dump restores is UNPROVEN in this run. Set KIT_PROOF_ADMIN_URL to a");
  console.log("  throwaway PostgreSQL superuser connection to exercise it.");
}
console.log("");
console.log("  What NO run of this harness proves: anything at all about Builds 1-6B");
console.log("  being live. This kit makes the handoff safe and repeatable. It is not");
console.log("  runtime proof, and the owner's real baseline has not been seen.");
process.exit(failed > 0 ? 1 : 0);
