#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   FALSIFY THE READ-ONLY GUARD

   _readonly.js is the only thing standing between three production-facing
   tools and a write. A guard that has never been observed to REFUSE is
   indistinguishable from a guard that always returns ok — and this repo
   has already shipped one of those: a probe whose SAVEPOINT error was
   returned as the refusal, so the check went green without the statement
   ever running.

   So this proves both directions, against a real writable PostgreSQL:

     POSITIVE  the guard opens, and a real INSERT is refused with 25006
     ORDERING  the probe runs BEFORE any read
     NEGATIVE  two surgical in-memory variants of _readonly.js — READ ONLY
               removed, and the savepoint broken — each make the guard
               REFUSE. The file on disk is never edited, and its digest is
               re-checked afterwards to prove it.
     SNAPSHOT  a concurrent committed INSERT is visible to a later read
               inside the held-open guarded transaction

   The SNAPSHOT case is the one that is easy to get wrong and expensive to
   get wrong quietly: signature_controls.js holds this transaction open
   while production writes through its own route. At REPEATABLE READ the
   census would be frozen and every control would report "wrote nothing" —
   a PASSING security control reported as a failure.

   ⚠ ISOLATED POSTGRES ONLY. Refuses to run against anything that is not
     a loopback address, because it needs a WRITABLE database to falsify
     against and must never be pointed at production.

   usage:
     FALSIFY_DATABASE_URL='postgresql://postgres@127.0.0.1:5455/rofalsify?sslmode=disable' \
       node tools/activation/readonly_falsify.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Client } = require("pg");
const { beginProvenReadOnly } = require("./_readonly.js");

const TARGET = process.env.FALSIFY_DATABASE_URL;
let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

//  A DIFFERENT VARIABLE NAME ON PURPOSE. If this read DATABASE_URL it
//  would be one careless shell away from opening a write-capable probe
//  against production, which is precisely the risk _readonly.js exists
//  to remove.
if (!TARGET) { console.error("REFUSED: FALSIFY_DATABASE_URL is not set."); process.exit(1); }
if (process.env.DATABASE_URL && process.env.DATABASE_URL === TARGET) {
  console.error("REFUSED: FALSIFY_DATABASE_URL is the same target as DATABASE_URL.");
  process.exit(1);
}
{
  const h = new (require("url").URL)(TARGET);
  if (!["127.0.0.1", "localhost", "::1"].includes(h.hostname)) {
    console.error("REFUSED: falsification needs a WRITABLE database and must stay on loopback.");
    console.error("         host was: " + h.hostname);
    process.exit(1);
  }
}

const open = async () => {
  const c = new Client({ connectionString: TARGET });
  await c.connect();
  return c;
};

(async function main() {
  console.log("FALSIFYING THE READ-ONLY GUARD (isolated postgres)\n");

  // ── PRECONDITION: the database really is writable ──────────────────
  //  Without this, every "write was refused" below could simply mean the
  //  database was read-only all along, and the guard would be credited
  //  for a refusal it did not cause.
  {
    const c = await open();
    await c.query("create table if not exists ro_probe_target (id serial primary key, v text)");
    await c.query("insert into ro_probe_target (v) values ('precondition')");
    const n = Number((await c.query("select count(*) n from ro_probe_target")).rows[0].n);
    ok("P0  the target database is genuinely WRITABLE (guard has something to refuse)", n >= 1, String(n));
    await c.end();
  }

  // ── POSITIVE: the guard opens, and the write really is refused ──────
  {
    const c = await open();
    const r = await beginProvenReadOnly(c, "positive");
    ok("P1  the guard reports ok on a healthy connection", r.ok === true, JSON.stringify(r));

    //  THIS READ MUST COME FIRST, and the ordering is load-bearing.
    //  P2 below deliberately provokes a 25006, and in PostgreSQL a failed
    //  statement aborts the entire transaction block — every later
    //  statement then dies with "current transaction is aborted". An
    //  earlier revision of THIS FILE asserted "reads still work" after
    //  the provocation and blew up, reporting a guard defect that did not
    //  exist. The guard's own probe is savepoint-wrapped and survivable;
    //  my deliberate INSERT is a different thing and must not be confused
    //  with it.
    let readable = null, readErr = null;
    try { readable = (await c.query("select count(*) n from ro_probe_target")).rows[0].n; }
    catch (e) { readErr = e.message; }
    ok("P2  reads work immediately after the probe (the guard's savepoint did not poison it)",
       readable !== null, readErr);

    //  Provoked inside its own savepoint so the transaction survives it
    //  and the later assertions still mean something.
    let wrote = false, refusal = null;
    await c.query("savepoint deliberate_write");
    try { await c.query("insert into ro_probe_target (v) values ('should never land')"); wrote = true; }
    catch (e) { refusal = e.code; }
    await c.query("rollback to savepoint deliberate_write");
    ok("P3  a real INSERT is REFUSED inside the guarded transaction", wrote === false, "the insert succeeded");
    //  25006 = read_only_sql_transaction. Asserting the CODE, not the
    //  message, so this cannot pass on an unrelated error such as a typo
    //  in the table name.
    ok("P4  refused for the RIGHT reason (25006 read_only_sql_transaction)",
       refusal === "25006", "got " + refusal);

    //  And the row count is UNCHANGED — the refusal is real, not a
    //  swallowed error over a write that actually landed.
    const after = (await c.query("select count(*) n from ro_probe_target")).rows[0].n;
    ok("P4b the refused INSERT left no row behind", String(after) === String(readable),
       "before " + readable + " after " + after);
    await c.end();
  }

  // ── ORDERING: no read is possible before the probe ─────────────────
  {
    const c = await open();
    const seen = [];
    const realQuery = c.query.bind(c);
    c.query = (...a) => { seen.push(String(a[0]).trim().toLowerCase().slice(0, 40)); return realQuery(...a); };
    await beginProvenReadOnly(c, "ordering");
    const probeAt = seen.findIndex((s) => s.startsWith("create temporary table"));
    const firstSelect = seen.findIndex((s) => s.startsWith("select"));
    ok("P5  the write probe runs BEFORE any select", probeAt > -1 && (firstSelect === -1 || probeAt < firstSelect),
       "probe@" + probeAt + " firstSelect@" + firstSelect + " :: " + JSON.stringify(seen));
    await c.end();
  }

  // ── NEGATIVE: the guard must be OBSERVED to refuse ──────────────────
  //  This is the falsification that matters. A guard never seen to come
  //  back not-ok is indistinguishable from `return {ok:true}`.
  //
  //  ⚠ AN EARLIER REVISION OF THIS CONTROL PROVED NOTHING, and the way it
  //  failed is worth keeping. It pre-opened a READ WRITE transaction and
  //  expected the guard's own BEGIN to be a no-op inside it — on the
  //  documented behaviour that BEGIN inside a transaction only warns.
  //  Measured, PostgreSQL 16 warns AND STILL APPLIES the transaction
  //  characteristics: transaction_read_only went off → on. So the guard
  //  refused the probe, the control "passed" its own negative case
  //  backwards, and the condition it claimed to create never existed.
  //
  //  The honest way to falsify a guard is to break the guard. The source
  //  on disk is NEVER edited — a variant is compiled in memory, exactly
  //  as tests/media_falsify.test.js does it.
  {
    const RO_PATH = path.join(__dirname, "_readonly.js");
    const RO_SRC = fs.readFileSync(RO_PATH, "utf8");
    const shaBefore = crypto.createHash("sha256").update(RO_SRC).digest("hex");

    const loadVariant = (src) => {
      const m = new Module(RO_PATH, null);
      m.filename = RO_PATH;
      m.paths = Module._nodeModulePaths(path.dirname(RO_PATH));
      m._compile(src, RO_PATH);
      return m.exports;
    };

    // ── N1: remove the READ ONLY mode ─────────────────────────────────
    const N1_FROM = "begin isolation level read committed read only";
    ok("P6  the falsification target is present in the source (else N1 proves nothing)",
       RO_SRC.includes(N1_FROM), "pattern not found: " + N1_FROM);
    const v1 = loadVariant(RO_SRC.replace(N1_FROM, "begin isolation level read committed read write"));
    {
      const c = await open();
      const r = await v1.beginProvenReadOnly(c, "falsified_rw");
      ok("P7  READ ONLY removed → the guard REFUSES", r.ok === false, JSON.stringify(r));
      ok("P8  and names the reason: the transaction accepted a write",
         r.ok === false && /ACCEPTED a write/.test(r.reason || ""), r.reason);
      try { await c.query("rollback"); } catch (_) {}
      await c.end();
    }

    // ── N2: break the savepoint so the probe cannot run ────────────────
    //  A probe that could not execute must NOT be credited as a probe
    //  that passed. This repo has shipped exactly that bug once already.
    const v2 = loadVariant(RO_SRC.replace('"savepoint " + probe', '"savepoint 9_not_an_identifier"'));
    {
      const c = await open();
      const r = await v2.beginProvenReadOnly(c, "falsified_savepoint");
      ok("P9  probe cannot run → the guard REFUSES rather than passing",
         r.ok === false, JSON.stringify(r));
      ok("P10 and says the probe could not be run",
         r.ok === false && /could not be run/.test(r.reason || ""), r.reason);
      try { await c.query("rollback"); } catch (_) {}
      await c.end();
    }

    ok("P11 the source on disk was never modified by this falsification",
       crypto.createHash("sha256").update(fs.readFileSync(RO_PATH, "utf8")).digest("hex") === shaBefore);
  }

  // ── SNAPSHOT: a concurrent commit is visible to a later read ─────────
  {
    const reader = await open();
    const writer = await open();
    const g = await beginProvenReadOnly(reader, "snapshot");
    ok("P12 guard open for the snapshot case", g.ok === true, JSON.stringify(g));

    const before = Number((await reader.query("select count(*) n from ro_probe_target")).rows[0].n);
    //  A DIFFERENT connection commits while the guarded transaction is
    //  still open — this is production's route writing during a run.
    await writer.query("insert into ro_probe_target (v) values ('concurrent commit')");
    const after = Number((await reader.query("select count(*) n from ro_probe_target")).rows[0].n);

    ok("P13 a concurrent committed INSERT IS visible to the held-open guarded transaction",
       after === before + 1,
       "before " + before + " after " + after +
       " — a frozen snapshot would report every signature control as writing nothing");
    await reader.end(); await writer.end();
  }

  console.log(`\n  passed ${pass}   failed ${fail}`);
  if (fail === 0) {
    console.log("\n  The guard refuses when it should and permits when it should.");
    console.log("  P7 and P9 are the ones that matter: it has been OBSERVED to refuse.");
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
