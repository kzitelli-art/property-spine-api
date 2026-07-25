// ════════════════════════════════════════════════════════════════════
//  LEAD SOURCE ATTRIBUTION PROOF
//
//  Covers two changes:
//    1. migrations/091_lead_source_system_bucket.sql — lets the intake
//       fallback create its house buckets ('Unattributed' / 'Unmapped')
//       instead of throwing. Proven by APPLYING THE REAL FILE inside a
//       transaction, exercising the previously-impossible insert, and
//       ROLLING THE WHOLE THING BACK. Production schema is unchanged when
//       this harness exits — verified explicitly at the end.
//    2. sourceConversion() — excludes internal_qa per PHILOSOPHY §23 and
//       counts tours from BOTH tour stores. Proven read-only by running
//       the old and new queries side by side against live data.
//
//  FALSIFIABLE: arm A asserts the insert fails BEFORE the migration. If
//  091 were unnecessary, arm A would pass the insert and this harness
//  goes red. Arm C asserts the OLD projection is wrong on live data; if
//  it were already right, the harness goes red.
//
//    DATABASE_URL=... node tests/lead_source_attribution_proof.js
// ════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEMO = process.env.ATTR_PROOF_PROPERTY_ID || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const MIGRATION = path.join(__dirname, "..", "migrations", "091_lead_source_system_bucket.sql");

let pass = 0, fail = 0;
const chk = (n, c, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

const OLD_TOURS = `exists (select 1 from scheduled_tours st
                            where st.person_id = ll.person_id and st.property_id = ll.property_id)`;
const NEW_TOURS = `exists (select 1 from scheduled_tours st
                            where st.person_id = ll.person_id and st.property_id = ll.property_id)
                   or exists (select 1 from leasing_tours lt where lt.lead_id = ll.id)`;
const QA_EXCLUSION = `and not exists (
    select 1 from person_property_classifications c
     where c.person_id = ll.person_id and c.property_id = ll.property_id
       and c.superseded_at is null and c.record_class = 'internal_qa')`;

function strip(toursExpr, qaClause) {
  return `select coalesce(ls.name,'(no source)') as source,
                 count(ll.id)::int as leads,
                 count(ll.id) filter (where ${toursExpr})::int as tours,
                 count(ll.id) filter (where ll.status = 'leased')::int as leases
            from leasing_leads ll
            left join lead_sources ls on ls.id = ll.source_id
           where ll.property_id = $1 ${qaClause}
           group by coalesce(ls.name,'(no source)')
           order by leads desc`;
}

async function main() {
  console.log("═══ LEAD SOURCE ATTRIBUTION ═══\n");

  // STATE-AWARE. This harness is meaningful both before and after 091 is
  // applied, and green in both states. A test that is permanently red once
  // the fix ships trains people to ignore it, which is the same failure mode
  // as a test that cannot fail — it stops being evidence either way.
  const liveDef0 = (await pool.query(
    `select pg_get_constraintdef(con.oid) def from pg_constraint con
      join pg_class c on c.oid=con.conrelid
     where c.relname='lead_sources' and con.contype='c'`)).rows.map(r => r.def).join(" ");
  const APPLIED = /'system'/.test(liveDef0);
  console.log(`  migration 091 is ${APPLIED ? "APPLIED" : "NOT YET APPLIED"} on this database\n`);

  // ── A. the house bucket: impossible before 091, possible after ──────
  console.log("─── A. can the house bucket be created? ───");
  {
    const c = await pool.connect();
    let code = null, ok = null;
    try {
      await c.query("begin");
      try {
        const r = await c.query(
          `insert into lead_sources (name, source_type) values ('__PROOF_A__','system') returning source_type`);
        ok = r.rows[0].source_type;
      } catch (e) { code = e.code; }
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
    if (!APPLIED) {
      chk("PRE-091: source_type 'system' is rejected (23514) — 091 is load-bearing",
        code === "23514", `got ${code}`);
    } else {
      chk("POST-091: the house bucket insert succeeds — the intake fallback can complete",
        ok === "system" && code === null, `code=${code} ok=${ok}`);
      const led = (await pool.query(
        `select version from schema_migrations where version='091'`)).rows[0];
      chk("POST-091: the ledger records 091 as applied", !!led, JSON.stringify(led));
    }
  }

  // ── B. APPLY THE REAL MIGRATION, EXERCISE IT, ROLL IT BACK ──────────
  console.log("\n─── B. apply migrations/091 in a transaction, then roll back ───");
  const sql = fs.readFileSync(MIGRATION, "utf8");
  chk("the migration file exists and is non-empty", sql.trim().length > 0);
  chk("the migration contains no begin/commit (migrate.js owns the transaction)",
    !/^\s*(begin|commit)\s*;/im.test(sql));
  {
    const c = await pool.connect();
    let applied = false, inserted = null, reapplied = false;
    try {
      await c.query("begin");
      await c.query(sql);                       // the real file, verbatim
      applied = true;
      await c.query(sql);                       // idempotence: apply twice
      reapplied = true;
      const r = await c.query(
        `insert into lead_sources (name, source_type) values ('__PROOF_B__','system') returning id, source_type`);
      inserted = r.rows[0];
    } catch (e) {
      console.error("  arm B error:", e.message);
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
    chk("the migration applies cleanly against the live schema", applied === true);
    chk("the migration is idempotent (applies twice in a row)", reapplied === true);
    chk("POST-091: the house bucket insert now SUCCEEDS",
      !!inserted && inserted.source_type === "system", JSON.stringify(inserted));
  }

  // ── B2. this harness changed nothing, whichever state we are in ─────
  console.log("\n─── B2. nothing leaked out of the rollback ───");
  const def = (await pool.query(
    `select pg_get_constraintdef(con.oid) def from pg_constraint con
      join pg_class c on c.oid=con.conrelid
     where c.relname='lead_sources' and con.contype='c'`)).rows.map(r => r.def).join(" ");
  // The invariant is that the harness did not CHANGE the constraint — not that
  // the constraint has any particular value. Compare against the state we read
  // on entry, so this holds before and after the real migration lands.
  chk("the live constraint is exactly as it was when this harness started",
    def === liveDef0, `before=${liveDef0} after=${def}`);
  const strays = (await pool.query(
    `select count(*)::int n from lead_sources where name like '__PROOF_%'`)).rows[0].n;
  chk("no __PROOF_ rows committed", strays === 0, `n=${strays}`);

  // ── C. the projection: old vs new, on live data ─────────────────────
  console.log("\n─── C. sourceConversion — old vs new against live data ───");
  const oldRows = (await pool.query(strip(OLD_TOURS, ""), [DEMO])).rows;
  const newRows = (await pool.query(strip(NEW_TOURS, QA_EXCLUSION), [DEMO])).rows;
  const sum = (rows, k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);

  console.log("  OLD: " + oldRows.map(r => `${r.source}=${r.leads}L/${r.tours}T`).join("  "));
  console.log("  NEW: " + newRows.map(r => `${r.source}=${r.leads}L/${r.tours}T`).join("  "));

  chk("OLD projection reports ZERO tours for every source — the bug",
    sum(oldRows, "tours") === 0, `old tours=${sum(oldRows, "tours")}`);
  chk("NEW projection surfaces real tours that were invisible",
    sum(newRows, "tours") > 0, `new tours=${sum(newRows, "tours")}`);
  chk("NEW projection counts FEWER leads (internal_qa fixtures removed)",
    sum(newRows, "leads") < sum(oldRows, "leads"),
    `old=${sum(oldRows, "leads")} new=${sum(newRows, "leads")}`);

  const qaLeft = (await pool.query(
    `select count(*)::int n from leasing_leads ll
      where ll.property_id=$1 and exists (
        select 1 from person_property_classifications c
         where c.person_id=ll.person_id and c.property_id=ll.property_id
           and c.superseded_at is null and c.record_class='internal_qa')`, [DEMO])).rows[0].n;
  chk("internal_qa leads exist at this property (so the exclusion is doing work)",
    qaLeft > 0, `n=${qaLeft}`);
  chk("NEW lead total equals OLD minus the internal_qa rows",
    sum(newRows, "leads") === sum(oldRows, "leads") - qaLeft,
    `${sum(newRows, "leads")} vs ${sum(oldRows, "leads")} - ${qaLeft}`);

  console.log(`\n═ RESULT: ${pass} passed, ${fail} failed ═`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async e => {
  console.error("ATTRIBUTION PROOF ERROR:", e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
