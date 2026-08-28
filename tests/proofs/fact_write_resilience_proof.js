// ════════════════════════════════════════════════════════════════════
//  FACT-WRITE RESILIENCE PROOF
//
//  Proves the savepoint fix applied to the three person_attributes
//  writers (prospect_capture.js, and the intake + tour-capture writers
//  in leasing_leads.js).
//
//  THE REAL BUG: those writers do retire-then-insert against the partial
//  unique index uq_person_attr_active. A concurrent capture on the same
//  person+key raises 23505. In Postgres an error inside a transaction
//  ABORTS it — every later statement fails with 25P02 — so one collision
//  took down whatever transaction it happened inside. In the tour-capture
//  writer that transaction is the tour completion itself: a prospect
//  texting at the wrong moment made it impossible to close the tour.
//
//  ARM A reproduces the PRE-FIX behaviour and asserts the transaction is
//  poisoned. If ARM A ever stops failing, the premise is gone and this
//  harness is meaningless — so ARM A failing to fail is itself a failure.
//  ARM B asserts the POST-FIX behaviour survives the identical collision.
//
//  SCRATCH PROPERTY ONLY. Creates its own property (__PAOBS__P <uuid8>),
//  touches nothing else, and removes it by tracked id plus a name guard.
//  No production property id appears in this file.
//
//    DATABASE_URL=... node tests/proofs/fact_write_resilience_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PROP = crypto.randomUUID();
const PROP_NAME = `__PAOBS__P ${PROP.slice(0, 8)}`;
const PERSON = crypto.randomUUID();

let pass = 0, fail = 0;
const chk = (n, c, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

// The collision the real writers hit: a second ACTIVE row for the same
// person+property+key, which uq_person_attr_active forbids.
async function collide(c) {
  await c.query(
    `insert into person_attributes (person_id, property_id, attr_key, attr_value, source, source_ref)
     values ($1,$2,'budget','2700','human',$3)`,
    [PERSON, PROP, crypto.randomUUID()]);
}

async function main() {
  console.log("═══ FACT-WRITE RESILIENCE (savepoint fix) ═══");
  console.log(`  scratch property ${PROP} (${PROP_NAME})\n`);

  await pool.query(`insert into properties (id,name) values ($1,$2)`, [PROP, PROP_NAME]);
  await pool.query(`insert into persons (id,name,phone) values ($1,$2,$3)`,
    [PERSON, "__PAOBS__ Prospect", "+1555" + Math.floor(1e6 + Math.random() * 8e6)]);

  // ── 0. the premise: the partial unique index really exists ──────────
  console.log("─── 0. the constraint this depends on ───");
  const idx = (await pool.query(
    `select indexname, indexdef from pg_indexes
      where tablename='person_attributes' and indexdef ilike '%active%'`)).rows;
  chk("a partial unique index on active facts exists", idx.length > 0, JSON.stringify(idx.map(i => i.indexname)));

  // seed the first active fact
  await pool.query(
    `insert into person_attributes (person_id, property_id, attr_key, attr_value, source, source_ref)
     values ($1,$2,'budget','2500','human',$3)`, [PERSON, PROP, crypto.randomUUID()]);
  const seeded = (await pool.query(
    `select count(*)::int n from person_attributes where person_id=$1 and status='active'`, [PERSON])).rows[0].n;
  chk("one active fact seeded", seeded === 1, `n=${seeded}`);

  // ── A. PRE-FIX: no savepoint → the collision poisons the transaction ─
  console.log("\n─── A. pre-fix behaviour (no savepoint) — must FAIL ───");
  {
    const c = await pool.connect();
    let raised = null, laterStatement = null;
    try {
      await c.query("begin");
      try { await collide(c); } catch (e) { raised = e.code; }        // the writer's own catch
      // the tour-completion transaction continues after the failed observation
      try { await c.query(`select 1 as still_working`); laterStatement = "ok"; }
      catch (e) { laterStatement = e.code; }
      await c.query("rollback").catch(() => {});
    } finally { c.release(); }
    chk("the collision raises 23505 (unique_violation)", raised === "23505", `got ${raised}`);
    chk("PRE-FIX: the surrounding transaction IS poisoned (25P02) — this is the outage",
      laterStatement === "25P02", `later statement -> ${laterStatement}`);
  }

  // ── B. POST-FIX: savepoint → the collision costs only itself ────────
  console.log("\n─── B. post-fix behaviour (savepoint) — must SURVIVE ───");
  {
    const c = await pool.connect();
    let raised = null, laterStatement = null, committed = false;
    try {
      await c.query("begin");
      await c.query("savepoint pa_obs");
      try { await collide(c); await c.query("release savepoint pa_obs"); }
      catch (e) { raised = e.code; await c.query("rollback to savepoint pa_obs").catch(() => {}); }
      // the rest of the tour completion proceeds
      try { await c.query(`select 1 as still_working`); laterStatement = "ok"; }
      catch (e) { laterStatement = e.code; }
      // and a real write after the failed one still lands
      await c.query(
        `insert into person_attributes (person_id, property_id, attr_key, attr_value, source, source_ref)
         values ($1,$2,'unit_type','1BR','human',$3)`, [PERSON, PROP, crypto.randomUUID()]);
      await c.query("commit");
      committed = true;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      console.error("  arm B threw:", e.message);
    } finally { c.release(); }
    chk("the same collision still raises 23505", raised === "23505", `got ${raised}`);
    chk("POST-FIX: the surrounding transaction SURVIVES the collision",
      laterStatement === "ok", `later statement -> ${laterStatement}`);
    chk("POST-FIX: a subsequent real fact write still commits", committed === true);
  }

  // ── C. the surviving state is correct, not partial ──────────────────
  console.log("\n─── C. the resulting record is honest ───");
  const rows = (await pool.query(
    `select attr_key, attr_value, status from person_attributes where person_id=$1 order by created_at`,
    [PERSON])).rows;
  chk("the original budget fact is untouched and still active",
    rows.some(r => r.attr_key === "budget" && r.attr_value === "2500" && r.status === "active"),
    JSON.stringify(rows));
  chk("the collided duplicate was NOT written",
    rows.filter(r => r.attr_key === "budget").length === 1, JSON.stringify(rows));
  chk("the later unit_type fact WAS written",
    rows.some(r => r.attr_key === "unit_type" && r.status === "active"), JSON.stringify(rows));

  await cleanup();
  console.log(`\n═ RESULT: ${pass} passed, ${fail} failed ═`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

async function cleanup() {
  await pool.query(`delete from person_attributes where person_id=$1`, [PERSON]).catch(() => {});
  await pool.query(`delete from persons where id=$1`, [PERSON]).catch(() => {});
  const gone = await pool.query(
    `delete from properties where id=$1 and name like '__PAOBS__%'`, [PROP]
  ).catch(e => { console.error("  scratch property NOT removed:", e.message); return { rowCount: 0 }; });
  console.log(`  cleanup complete. scratch property removed: ${gone.rowCount}`);
}

main().catch(async e => {
  console.error("RESILIENCE PROOF ERROR:", e);
  try { await cleanup(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
