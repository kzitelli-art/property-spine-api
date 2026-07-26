// ════════════════════════════════════════════════════════════════════
//  PRESENCE WALL — A LEASE IS PRESENCE (owner ruling, 2026-07-25)
//
//  FALSIFIABLE BY CONSTRUCTION. This harness does not test a copy of the
//  wall — it EXTRACTS the live SQL from src/identity/operator.js at run
//  time and executes it against real Postgres. If the shipped clause is
//  edited or removed, this fails.
//
//  It proves three things, and fails loudly on any of them:
//    1. THE BUG WAS REAL — the pre-fix 4-way wall (leads/conversations/
//       attrs/conversions) BLOCKS a person whose only tie to the property
//       is that they live there. If the pre-fix wall admits them, the bug
//       never existed and this harness is worthless: hard fail.
//    2. THE FIX WORKS — the shipped wall ADMITS that same resident.
//    3. THE WALL STILL WALLS — a person with NO tie to the property is
//       still refused. Widening presence must not dissolve it.
//
//  READ-ONLY. No inserts, no updates, no deletes, no property-wide
//  anything. Anchors are DISCOVERED live, never hardcoded, so the proof
//  survives data drift.
//
//  Run (PowerShell, from api/):
//    $env:DATABASE_URL = ...
//    node tests/presence_wall_lease_proof.js
// ════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DEMO_PROPERTY = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"; // Demo Building
const SRC = path.join(__dirname, "..", "src", "identity", "operator.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// ── Extract the wall SQL from the SHIPPING source ────────────────────
function extractWallSql() {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("select 1 where exists (select 1 from leasing_leads");
  if (start === -1) throw new Error("could not locate the presence wall in operator.js — did it move?");
  const end = src.indexOf("`", start);
  if (end === -1) throw new Error("could not find the end of the presence wall SQL");
  return src.slice(start, end);
}

// The pre-fix wall = the shipped wall with the lease clause removed.
function stripLeaseClause(sql) {
  const marker = sql.indexOf("-- A LEASE IS PRESENCE");
  if (marker === -1) return null; // clause absent → fix not shipped
  // walk back to the "or exists" that this comment block introduces
  const cut = sql.lastIndexOf("or exists", marker) === -1 ? marker : marker;
  return sql.slice(0, cut).replace(/\s+$/, "");
}

async function admits(sql, personId, propertyId) {
  const r = await pool.query(sql, [personId, propertyId]);
  return r.rows.length > 0;
}

(async () => {
  console.log("PRESENCE WALL — lease-is-presence proof");
  console.log("property:", DEMO_PROPERTY, "\n");

  const shippedSql = extractWallSql();
  const preFixSql = stripLeaseClause(shippedSql);

  console.log("[0] the fix is present in the shipping source");
  check(preFixSql !== null, "operator.js contains the lease clause",
        preFixSql === null ? "NOT FOUND — nothing to prove" : "found");
  if (preFixSql === null) { failures++; return; }
  check(/from leases/.test(shippedSql), "shipped wall queries `leases`");
  check(/tenant_ids/.test(shippedSql), "shipped wall tests `tenant_ids`");
  check(!/from leases/.test(preFixSql), "reconstructed pre-fix wall does NOT query `leases`");

  // ── Anchor 1: a resident whose ONLY tie is the lease ──────────────
  const blocked = (await pool.query(
    `with res as (
       select distinct p.id, p.name
         from leases l
         join unnest(l.tenant_ids) t(pid) on true
         join persons p on p.id = t.pid
        where l.property_id = $1)
     select res.id, res.name from res
      where not (
         exists (select 1 from leasing_leads x       where x.person_id = res.id and x.property_id = $1)
      or exists (select 1 from conversations x       where x.person_id = res.id and x.property_id = $1)
      or exists (select 1 from person_attributes x   where x.person_id = res.id and x.property_id = $1)
      or exists (select 1 from leasing_conversions x where x.person_id = res.id and x.property_id = $1))
      limit 1`, [DEMO_PROPERTY])).rows[0];

  console.log("\n[1] THE BUG WAS REAL — pre-fix wall blocks a lease-only resident");
  if (!blocked) {
    check(false, "found a lease-only resident to test",
          "none exist at this property — the harness cannot prove anything");
  } else {
    const preAdmits = await admits(preFixSql, blocked.id, DEMO_PROPERTY);
    check(preAdmits === false, `pre-fix wall REFUSES ${blocked.name}`,
          preAdmits ? "it ADMITTED them — the bug was never real, this proof is void" : "404, as the defect predicts");

    console.log("\n[2] THE FIX WORKS — shipped wall admits that same resident");
    const nowAdmits = await admits(shippedSql, blocked.id, DEMO_PROPERTY);
    check(nowAdmits === true, `shipped wall ADMITS ${blocked.name}`,
          nowAdmits ? "visible on the card" : "still refused — the fix does not work");
  }

  // ── Anchor 2: a person with no tie at all ─────────────────────────
  const stranger = (await pool.query(
    `select p.id, p.name from persons p
      where not exists (select 1 from leasing_leads x       where x.person_id=p.id and x.property_id=$1)
        and not exists (select 1 from conversations x       where x.person_id=p.id and x.property_id=$1)
        and not exists (select 1 from person_attributes x   where x.person_id=p.id and x.property_id=$1)
        and not exists (select 1 from leasing_conversions x where x.person_id=p.id and x.property_id=$1)
        and not exists (select 1 from leases l where l.property_id=$1 and l.tenant_ids is not null
                         and l.tenant_ids @> array[p.id])
      limit 1`, [DEMO_PROPERTY])).rows[0];

  console.log("\n[3] THE WALL STILL WALLS — no tie means no card");
  if (!stranger) {
    check(false, "found an unrelated person to test", "everyone has presence here — cannot prove containment");
  } else {
    const leaks = await admits(shippedSql, stranger.id, DEMO_PROPERTY);
    check(leaks === false, `shipped wall REFUSES ${stranger.name}`,
          leaks ? "LEAK — the widened wall admits a stranger" : "404, correctly");
  }

  // ── Scale of the change (reported, not asserted) ──────────────────
  const scale = (await pool.query(
    `with res as (
       select distinct p.id, l.property_id
         from leases l
         join unnest(l.tenant_ids) t(pid) on true
         join persons p on p.id = t.pid
        where l.lease_status = 'active')
     select count(*)::int as residents,
            count(*) filter (where not (
               exists (select 1 from leasing_leads x       where x.person_id=res.id and x.property_id=res.property_id)
            or exists (select 1 from conversations x       where x.person_id=res.id and x.property_id=res.property_id)
            or exists (select 1 from person_attributes x   where x.person_id=res.id and x.property_id=res.property_id)
            or exists (select 1 from leasing_conversions x where x.person_id=res.id and x.property_id=res.property_id)
            ))::int as newly_visible
       from res`)).rows[0];
  console.log(`\n[4] SCALE — ${scale.newly_visible} of ${scale.residents} active-lease residents stop 404-ing.`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
