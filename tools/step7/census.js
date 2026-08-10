#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 7 — THE FRESH CUTOVER CENSUS  (read-only, proven before it reads)

   Produces the EXACT terminal-without-evaluation set that the activation
   transaction will be asked to match, plus a digest of it, as the cutover
   receipt.

   ── THE AUGUST 6 AUDIT IS NOT THE EXPECTED SET ──────────────────────

   §6.2 is explicit: it is historical evidence, and it may not be used as
   the deployment-time expected set. Production moves. Revision 2 of the
   plan treated a months-old identifier list as current, and that is the
   mistake this tool exists to make impossible — the set is taken fresh,
   minutes before activation, or it is not taken.

   ── BEING NAMED "CENSUS" IS NOT AUTHORIZATION ───────────────────────

   §6.2 step 1 requires a SPECIFIC owner authorization for one read-only
   census against production. So this refuses to run without
   R0_CENSUS_AUTHORIZATION naming who authorized it and when, and prints
   that string into the receipt. A tool that authorizes itself by existing
   is the thing the rule forbids.

   ── WHAT IT PRINTS ──────────────────────────────────────────────────

   Work-order and property identifiers, status, and two booleans about the
   legacy columns. NEVER a phone number, a media URL, attachment bytes, or
   the content of a note. The identifiers are the point — a count is not a
   set, and §6.2 exists because counts can match over different rows.

   usage (Render shell on the live service, DATABASE_URL already set):
     R0_CENSUS_AUTHORIZATION='authorized by <owner> 2026-08-08 for step 7' \
       node tools/step7/census.js
     R0_CENSUS_AUTHORIZATION='...' node tools/step7/census.js --json > census.json
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } =
  require(path.join(__dirname, "..", "activation", "_readonly.js"));
const { LEGACY_TERMINAL_SET_SQL } =
  require(path.join(__dirname, "..", "..", "src/release0/activation_service.js"));

const JSON_ONLY = process.argv.includes("--json");
const say = (...a) => { if (!JSON_ONLY) console.log(...a); };

(async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("REFUSED: DATABASE_URL is not set."); process.exit(1);
  }
  const auth = (process.env.R0_CENSUS_AUTHORIZATION || "").trim();
  if (!auth) {
    console.error("REFUSED: R0_CENSUS_AUTHORIZATION is not set.");
    console.error("");
    console.error("  §6.2 requires a SPECIFIC owner authorization for one read-only");
    console.error("  census immediately before step 7. Being named \"census\" is not");
    console.error("  authorization. Set it to who authorized this run and when — the");
    console.error("  string is printed into the receipt.");
    console.error("");
    console.error("    R0_CENSUS_AUTHORIZATION='authorized by <owner> <date> for step 7' \\");
    console.error("      node tools/step7/census.js");
    process.exit(2);
  }
  if (auth.length < 12) {
    console.error("REFUSED: R0_CENSUS_AUTHORIZATION is too short to be a real authorization.");
    console.error("         It goes into the receipt as the record of who permitted this read.");
    process.exit(2);
  }

  const insecureLocal = /sslmode=disable/.test(process.env.DATABASE_URL);
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: insecureLocal ? false : { rejectUnauthorized: false } });
  await c.connect();

  //  PROVEN read-only, BEFORE any read. A safety check that runs after the
  //  data has been read is a report, not a guard.
  const ro = await beginProvenReadOnly(c, "r0_census");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  const takenAt = (await c.query(`select now() as t`)).rows[0].t;
  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;

  //  The SAME statement the activation transaction will run. Imported, not
  //  restated: two copies of "what counts as legacy" is how the expected
  //  set and the live set come to disagree for a reason that is not drift.
  const { rows } = await c.query(LEGACY_TERMINAL_SET_SQL);

  //  The digest covers the SET, in the query's deterministic order, and
  //  nothing else — not the timestamp, not the authorization — so two
  //  censuses of an unchanged population produce the same digest and a
  //  changed population cannot produce a matching one.
  const canonical = JSON.stringify(rows.map((r) => ({
    work_order_id: r.work_order_id, property_id: r.property_id, status: r.status,
    had_column_photo: r.had_column_photo, had_column_note: r.had_column_note,
  })));
  const digest = crypto.createHash("sha256").update(canonical).digest("hex");

  const receipt = {
    kind: "release_0_cutover_census",
    authorization: auth,
    taken_at: takenAt,
    ledger_ceiling: ledger,
    read_only_proven: true,
    count: rows.length,
    digest,
    set: rows,
  };

  if (JSON_ONLY) { console.log(JSON.stringify(receipt, null, 2)); await c.end(); return; }

  say("RELEASE 0 — CUTOVER CENSUS  (read-only proven)\n");
  say("  authorization   " + auth);
  say("  taken at        " + takenAt.toISOString());
  say("  ledger ceiling  " + ledger);
  say("  terminal work orders with NO proof evaluation: " + rows.length);
  say("  sha256          " + digest);
  say("");
  if (rows.length === 0) {
    say("  The set is EMPTY. That is a legitimate result, not a failed run —");
    say("  it means no terminal work order predates the proof rail without an");
    say("  evaluation. The activation still records the instant.");
  } else {
    say("  " + "work_order_id".padEnd(38) + "status      photo note");
    for (const r of rows) {
      say("  " + String(r.work_order_id).padEnd(38) + String(r.status).padEnd(12) +
          (r.had_column_photo ? " yes " : "  no ") + (r.had_column_note ? " yes" : "  no"));
    }
  }
  say("");
  say("  Preserve this output and its digest as the cutover receipt (§6.2 step 3),");
  say("  then supply the SET to the activation transaction as the expected set.");
  say("  Re-run it if more than a few minutes pass — a stale census is the whole");
  say("  reason this tool exists.");
  await c.end();
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
