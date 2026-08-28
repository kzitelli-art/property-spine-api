/* ══════════════════════════════════════════════════════════════════════════
   slice8_governed_economics_proof.js — Slice 8, steps 1–4.

   Proves the governed-economics socket against REAL Postgres, inside a
   transaction that is rolled back. The point is not that migration 122 added
   columns — it is that:

     · a renewal with no published sheet says WHY, instead of a bare null;
     · a published governed sheet FILLS the renewal socket with the sheet's
       own number and carries the version id as lineage;
     · an AMBIGUOUS sheet (several renewal terms) refuses to guess a term and
       names the ambiguity;
     · the publish route is mounted and defaults to a rehearsal;
     · nothing survives the rollback.

   Requires DATABASE_URL. Refuses to report green without it — a proof that
   silently skips its own subject is worse than no proof.

   Run:  node tests/proofs/slice8_governed_economics_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { Pool } = require("pg");

const REPO = path.join(__dirname, "..", "..");
const { renewalsCohortEnriched } = require(path.join(REPO, "src/leasing/renewals_read"));
const { renewalLifecycle } = require(path.join(REPO, "src/leasing/renewal_lifecycle"));
const { governedConcessions, STATES } = require(path.join(REPO, "src/money/concessions_read"));

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

if (!process.env.DATABASE_URL) {
  console.error("\nDATABASE_URL is required. This proof asserts against real Postgres and will not fake a pass.\n");
  process.exit(1);
}

// A client dressed as a pool, so the production read path runs verbatim
// inside our transaction rather than against a parallel implementation.
const asPool = (c) => ({
  query: (...a) => c.query(...a),
  connect: async () => ({ query: (...a) => c.query(...a), release() {} }),
});

// Terms are writable ONLY while a version is draft (trg_pricing_terms_frozen),
// and only one version may be published per property at a time
// (uq_ppv_one_published). Both are correct governance, so the proof publishes
// the way the product must: draft → author terms → publish → retire.
async function publishSheet(c, propertyId, typeId, terms) {
  const verId = (await c.query(
    `insert into property_pricing_versions (property_id, status, effective_from, reason_code)
     values ($1,'draft', now() - interval '1 day', 'renewal_strategy') returning id`,
    [propertyId])).rows[0].id;
  for (const t of terms) {
    await c.query(
      `insert into pricing_terms (pricing_version_id, property_id, unit_type_id,
         lease_term_months, base_rent, renewal_rent)
       values ($1,$2,$3,$4,$5,$6)`,
      [verId, propertyId, typeId, t.months, t.base, t.renewal]);
  }
  await c.query(
    "update property_pricing_versions set status='published', published_at=now() where id=$1", [verId]);
  return verId;
}
const retireSheet = (c, verId) => c.query(
  "update property_pricing_versions set status='retired', effective_until=now() where id=$1", [verId]);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  section("A  pure lifecycle — a blank always carries a reason");
  {
    const noEcon = renewalLifecycle({
      days_until_expiration: 30, current_rent: 1600,
      economics_unavailable_reason: "no_published_pricing_version",
    }, "2026-08-01");
    ok("no governed economics ⇒ has_governed_economics false", noEcon.has_governed_economics === false);
    ok("no governed economics ⇒ proposed_rent null", noEcon.proposed_rent === null);
    ok("the blank is explained, not bare",
      noEcon.economics_unavailable_reason === "no_published_pricing_version");

    const withEcon = renewalLifecycle({
      days_until_expiration: 30, current_rent: 1600,
      governed_proposed_rent: 1750, economics_source: "governed_pricing_version",
      economics_as_of: "2026-08-01",
      economics_unavailable_reason: "should_be_cleared",
    }, "2026-08-01");
    ok("governed economics ⇒ has_governed_economics true", withEcon.has_governed_economics === true);
    ok("governed economics ⇒ proposed_rent fills", withEcon.proposed_rent === 1750);
    ok("a reason is CLEARED once economics exist", withEcon.economics_unavailable_reason === null);
    ok("change amount is derived, not invented", withEcon.effective_change_amount === 150);
    ok("change percent is derived", withEcon.effective_change_percent === 9.4);
  }

  const prop = (await pool.query(
    "select id from properties where name=$1", ["S4 Proof Property"])).rows[0];
  if (!prop) { console.error("\nfixture property missing — cannot prove against real data\n"); process.exit(1); }

  section("B  baseline against real Postgres");
  const base = await renewalsCohortEnriched(pool, { property_id: prop.id });
  const baseRow = base.rows[0];
  ok("cohort returns at least one open renewal", !!baseRow);
  ok("baseline proposed_rent is null", baseRow && baseRow.proposed_rent === null);
  ok("baseline names the reason: no_published_pricing_version",
    baseRow && baseRow.economics_unavailable_reason === "no_published_pricing_version");
  ok("baseline claims no pricing version lineage",
    baseRow && baseRow.economics_version_id === null);

  const c = await pool.connect();
  try {
    await c.query("begin");
    const P = asPool(c);

    // Build the governed chain this property does not have yet.
    const typeId = (await c.query(
      `insert into property_unit_types (property_id, code, label, sort_order)
       values ($1,'S4T','Slice 8 Proof Type',1) returning id`, [prop.id])).rows[0].id;
    await c.query("update units set unit_type_id=$2 where id=$1", [baseRow.unit_id, typeId]);
    await c.query("update spaces set use_type='residential' where unit_id=$1", [baseRow.unit_id]);

    section("C  one governed renewal term FILLS the socket");
    const verId = await publishSheet(c, prop.id, typeId, [{ months: 12, base: 1800, renewal: 1750 }]);

    let out = await renewalsCohortEnriched(P, { property_id: prop.id });
    let row = out.rows.find((r) => String(r.unit_id) === String(baseRow.unit_id));
    ok("proposed_rent is the governed sheet's number", row && Number(row.proposed_rent) === 1750);
    ok("economics_source names the governed version",
      row && row.economics_source === "governed_pricing_version");
    ok("lineage carries the exact published version id",
      row && String(row.economics_version_id) === String(verId));
    ok("no unavailable reason once economics exist",
      row && row.economics_unavailable_reason === null);
    ok("has_governed_economics is true", row && row.has_governed_economics === true);

    section("D  an AMBIGUOUS sheet refuses to invent a term");
    await retireSheet(c, verId);
    const verAmbiguous = await publishSheet(c, prop.id, typeId, [
      { months: 12, base: 1800, renewal: 1750 },
      { months: 6, base: 1900, renewal: 1825 },
    ]);

    out = await renewalsCohortEnriched(P, { property_id: prop.id });
    row = out.rows.find((r) => String(r.unit_id) === String(baseRow.unit_id));
    ok("two differing renewal rents ⇒ proposed_rent goes null, not a guess",
      row && row.proposed_rent === null);
    ok("the ambiguity is named: multiple_governed_renewal_terms",
      row && row.economics_unavailable_reason === "multiple_governed_renewal_terms");
    ok("an ambiguous read claims NO version lineage",
      row && row.economics_version_id === null);

    section("E  a sheet with no renewal rent says so");
    await retireSheet(c, verAmbiguous);
    const verNoRenewal = await publishSheet(c, prop.id, typeId, [{ months: 12, base: 1800, renewal: null }]);

    out = await renewalsCohortEnriched(P, { property_id: prop.id });
    row = out.rows.find((r) => String(r.unit_id) === String(baseRow.unit_id));
    ok("a published sheet with no renewal rent ⇒ null", row && row.proposed_rent === null);
    ok("and names it: no_renewal_rent_in_governed_terms",
      row && row.economics_unavailable_reason === "no_renewal_rent_in_governed_terms");

    section("F  migration 122 — lineage and stacking");
    // Concession policies are frozen on a published version too, so author
    // them against a draft — the same way the product must.
    const draftId = (await c.query(
      `insert into property_pricing_versions (property_id, status, effective_from)
       values ($1,'draft', now()) returning id`, [prop.id])).rows[0].id;

    await c.query("savepoint lin");
    let lineageOk = false;
    try {
      await c.query(
        `update executed_lease_records set pricing_version_id=$1 where false`, [draftId]);
      lineageOk = true;
    } catch (_) { await c.query("rollback to savepoint lin"); }
    ok("executed_lease_records.pricing_version_id accepts a governed version id", lineageOk);

    await c.query("savepoint bad");
    let rejected = false;
    try {
      await c.query(
        `insert into concession_policies (pricing_version_id, property_id, concession_type, value, stacking_rule)
         values ($1,$2,'free_rent',1.0,'sometimes')`, [draftId, prop.id]);
    } catch (_) { rejected = true; await c.query("rollback to savepoint bad"); }
    ok("stacking_rule vocabulary is enforced by the database", rejected);

    const defRule = (await c.query(
      `insert into concession_policies (pricing_version_id, property_id, concession_type, value)
       values ($1,$2,'free_rent',1.0) returning stacking_rule`, [draftId, prop.id])).rows[0].stacking_rule;
    ok("stacking defaults to 'exclusive' — nothing stacks silently", defRule === "exclusive");

    section("F2  concession effective state is stated, never implied");
    // Only one version may be published per property at a time, and the
    // exclusion constraint enforces it — retire section E's sheet first.
    await retireSheet(c, verNoRenewal);
    const verC = (await c.query(
      `insert into property_pricing_versions (property_id, status, effective_from)
       values ($1,'draft', now() - interval '1 day') returning id`, [prop.id])).rows[0].id;
    // Bound parameters are VALUES, not SQL — compute the instants here.
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
    const addC = (from, until, active = true) => c.query(
      `insert into concession_policies
         (pricing_version_id, property_id, concession_type, value, valid_from, valid_until, active)
       values ($1,$2,'free_rent',1.0,$3,$4,$5) returning id`,
      [verC, prop.id, from, until, active]);
    await addC(day(-10), day(10));   // live today
    await addC(day(10), null);       // starts later
    await addC(null, day(-1));       // already over
    await addC(null, null, false);   // switched off
    await c.query("update property_pricing_versions set status='published', published_at=now() where id=$1", [verC]);

    const conc = await governedConcessions(P, { property_id: prop.id });
    ok("a concession inside its window is active_now", conc.counts.active_now === 1);
    ok("a future concession is scheduled, NOT active", conc.counts.scheduled === 1);
    ok("a past concession is expired, NOT active", conc.counts.expired === 1);
    ok("a deactivated concession is inactive", conc.counts.inactive === 1);
    ok("the published version is named", String(conc.published_version_id) === String(verC));
    ok("no false absence when something IS in effect", conc.absence === null);
    ok("every row carries an explicit state",
      conc.concessions.every((x) => STATES.includes(x.state)));
    ok("every row states a stacking rule", conc.concessions.every((x) => !!x.stacking_rule));

    await c.query("rollback");
  } finally { c.release(); }

  section("G  nothing survived the rollback");
  const after = await renewalsCohortEnriched(pool, { property_id: prop.id });
  const afterRow = after.rows[0];
  ok("proposed_rent is null again", afterRow && afterRow.proposed_rent === null);
  ok("reason is back to no_published_pricing_version",
    afterRow && afterRow.economics_unavailable_reason === "no_published_pricing_version");
  const leftover = (await pool.query(
    "select count(*)::int n from property_pricing_versions where property_id=$1", [prop.id])).rows[0].n;
  ok("no pricing version persisted", leftover === 0);

  section("H  the publish route is mounted and rehearses by default");
  const src = require("fs").readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8");
  ok("POST /operator/pricing/publish exists", /router\.post\("\/operator\/pricing\/publish"/.test(src));
  ok("it is behind requireOperator", /\/operator\/pricing\/publish",\s*requireOperator/.test(src));
  const routeBody = src.slice(src.indexOf('router.post("/operator/pricing/publish"'),
                              src.indexOf('router.post("/operator/pricing/publish"') + 1200);
  ok("property scope comes from the session, never the body",
    /property_id:\s*req\.operator\.property_id/.test(routeBody) && !/req\.body.*property_id/.test(routeBody));
  ok("dry_run defaults TRUE — publishing must be said out loud",
    /dry_run:\s*b\.dry_run\s*!==\s*false/.test(routeBody));

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.message, "\n"); process.exit(1); });
