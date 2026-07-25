// ════════════════════════════════════════════════════════════════════
//  INTAKE SOURCE FALLBACK PROOF
//
//  leasingleads.js intakeProspect assigns a lead with no source (or an
//  unrecognized source) to a house bucket — 'Unattributed' or 'Unmapped' —
//  creating it on first use:
//
//      insert into lead_sources (name, source_type) values ($1,'system')
//
//  lead_sources.source_type is CHECK-constrained to
//  (ils, website, paid_ad, organic, manual). 'system' is not in that list,
//  so the insert can never succeed. The savepoint catch then re-selects,
//  finds nothing, and `fb.id` throws on an undefined row — the whole
//  intake transaction fails.
//
//  Consequence: an intake supplying NO source, or any source name outside
//  the eight known ones, cannot capture. Only exact known names work.
//
//  EVERYTHING HERE RUNS INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK.
//  Creating the missing bucket for real would silently mask the defect,
//  so this proves it without leaving a row behind.
//
//    DATABASE_URL=... node tests/intake_source_fallback_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The exact constants from src/leasing/leasingleads.js
const SOURCE_UNATTRIBUTED = "Unattributed";
const SOURCE_UNMAPPED = "Unmapped";

let pass = 0, fail = 0;
const chk = (n, c, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

async function main() {
  console.log("═══ INTAKE SOURCE FALLBACK (read-mostly, always rolled back) ═══\n");

  // ── 1. the live constraint ──────────────────────────────────────────
  console.log("─── 1. the constraint the fallback violates ───");
  const def = (await pool.query(
    `select pg_get_constraintdef(con.oid) def from pg_constraint con
      join pg_class c on c.oid=con.conrelid
     where c.relname='lead_sources' and con.contype='c'`)).rows.map(r => r.def).join(" ");
  chk("lead_sources.source_type is CHECK-constrained", /source_type/.test(def), def);
  chk("'system' is NOT an allowed source_type", !/'system'/.test(def), def);

  // ── 2. the buckets do not exist ─────────────────────────────────────
  console.log("\n─── 2. the house buckets have never been created ───");
  const buckets = (await pool.query(
    `select name from lead_sources where lower(name) in (lower($1), lower($2))`,
    [SOURCE_UNATTRIBUTED, SOURCE_UNMAPPED])).rows;
  chk("neither 'Unattributed' nor 'Unmapped' exists", buckets.length === 0, JSON.stringify(buckets));

  // ── 3. the fallback insert genuinely fails (rolled back) ────────────
  console.log("\n─── 3. the fallback INSERT fails against the live table ───");
  {
    const c = await pool.connect();
    let code = null, reselect = null;
    try {
      await c.query("begin");
      try {
        await c.query(`insert into lead_sources (name, source_type) values ($1,'system')`,
          [SOURCE_UNATTRIBUTED]);
      } catch (e) { code = e.code; }
      // exactly what the catch block does next
      if (code) {
        await c.query("rollback to savepoint s").catch(() => {});
      }
      await c.query("rollback");
      // the re-select the real code performs after the failed insert
      reselect = (await pool.query(
        `select id from lead_sources where lower(name)=lower($1) order by id limit 1`,
        [SOURCE_UNATTRIBUTED])).rows[0];
    } finally { c.release(); }
    chk("the insert raises 23514 (check_violation)", code === "23514", `got ${code}`);
    chk("the re-select finds nothing → `fb` is undefined → `fb.id` throws",
      reselect === undefined, JSON.stringify(reselect));
  }

  // ── 4. only the known names work ────────────────────────────────────
  console.log("\n─── 4. which source names can actually be captured today ───");
  const known = (await pool.query(`select name, source_type from lead_sources order by name`)).rows;
  console.log("  capturable source names: " + known.map(k => k.name).join(", "));
  chk("a finite allowlist — anything else falls into the broken path", known.length > 0);

  // ── 5. the damage, measured ─────────────────────────────────────────
  console.log("\n─── 5. current attribution coverage ───");
  const cov = (await pool.query(
    `select (source_id is not null) as attributed, count(*)::int n from leasing_leads group by 1`)).rows;
  const missing = (cov.find(r => r.attributed === false) || { n: 0 }).n;
  const have = (cov.find(r => r.attributed === true) || { n: 0 }).n;
  const pct = Math.round((missing / Math.max(1, missing + have)) * 100);
  console.log(`  leads with NO source: ${missing} of ${missing + have} (${pct}%)`);
  chk("attribution gap is real and measurable", missing > 0, `${missing} unattributed`);

  // ── 6. nothing was left behind ──────────────────────────────────────
  console.log("\n─── 6. this harness left no trace ───");
  const after = (await pool.query(
    `select count(*)::int n from lead_sources where lower(name) in (lower($1), lower($2))`,
    [SOURCE_UNATTRIBUTED, SOURCE_UNMAPPED])).rows[0].n;
  chk("still zero house buckets — the defect was NOT masked by this run", after === 0, `n=${after}`);

  console.log(`\n═ RESULT: ${pass} passed, ${fail} failed ═`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async e => {
  console.error("FALLBACK PROOF ERROR:", e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
