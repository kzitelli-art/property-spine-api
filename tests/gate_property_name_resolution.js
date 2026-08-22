#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROPERTY NAME RESOLUTION — DOES THE CALLER KNOW, OR IS IT GUESSING?

       Q5_DATABASE_URL=postgres://…/disposable \
         node tests/gate_property_name_resolution.js

   Three rows share the name "Property Spine Demo Building" in
   production. Every caller that looks a property up by that name is
   choosing one of three, and four of them do it with
   `order by created_at asc limit 1` — the oldest, which is a coin flip
   with a receipt attached.

   ── WHAT THIS GATE ASSERTS ──────────────────────────────────────────
   It runs the ACTUAL SQL each call site issues, against a real database
   seeded with three same-named rows at staggered creation times, and
   records which row comes back. It does not simulate the query, and it
   does not assert on a copy of the query kept in this file — each
   statement is extracted from the source file at run time, so the gate
   cannot silently drift away from the code it is describing.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure, outside the operator workflow.
   REMOVAL CONDITION: when no source file issues a property lookup keyed
   on a non-unique column. This gate is how that becomes checkable, so
   it outlives the fix rather than being deleted with it.

   ── DATABASE ────────────────────────────────────────────────────────
   Refuses anything that is not localhost. It seeds and drops only rows
   it created, keyed by a UUID prefix it owns — never a property-wide
   delete. A harness once ran `delete from leasing_tours where
   property_id = <demo>` and destroyed a real completed tour on every
   run; scope every teardown to what you inserted.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const URL = process.env.Q5_DATABASE_URL
  || "postgres://postgres@127.0.0.1:55433/q5";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error("\n  ✗ REFUSED: this gate runs only against a local disposable database.\n");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const NAME = "Property Spine Demo Building";

/* Rows this gate owns. Teardown deletes exactly these ids. */
const OLDEST = "e5100000-0000-4000-8000-000000000001";
const MIDDLE = "e5100000-0000-4000-8000-000000000002";
const NEWEST = "e5100000-0000-4000-8000-000000000003";
const MINE = [OLDEST, MIDDLE, NEWEST];

/* ── The five call sites, each identified by the anchor TEXT of the
      statement it issues. Line numbers already drifted once between
      heads (operator.js 195 → 196), so nothing here anchors to one. ── */
const SITES = [
  { id: "operator.js · demo access",
    file: "src/identity/operator.js",
    anchor: "select id from properties where name=$1 order by created_at asc limit 1" },
  { id: "demo_reset.js · reset scope",
    file: "src/leasing/demo_reset.js",
    anchor: "select id, name from properties where name=$1 order by created_at asc limit 1" },
  { id: "demo_preflight.js · preflight",
    file: "src/leasing/demo_preflight.js",
    anchor: "select id from properties where name = $1 order by created_at asc limit 1" },
  { id: "leasingleads.js · demo intake",
    file: "src/leasing/leasingleads.js",
    anchor: "select id, name, coalesce(display_name, name) as display_name from properties where name=$1 order by created_at asc limit 1" },
  { id: "leasingleads.js · AUTHORIZATION wall",
    file: "src/leasing/leasingleads.js",
    anchor: "select id, name from properties where name=$1",
    exact: true,
    note: "no limit at all — takes rows[0]" },
];

let pass = 0, fail = 0, red = 0;
const line = (s = "") => console.log(s);
function ok(name, cond, detail = "") {
  if (cond) { pass++; line(`  ✔ ${name}`); }
  else { fail++; line(`  ✘ ${name}${detail ? "\n      " + detail : ""}`); }
}
function isRed(name, cond, detail = "") {
  if (cond) { red++; line(`  ● RED  ${name}${detail ? "\n           " + detail : ""}`); }
  else { fail++; line(`  ✘ EXPECTED RED, GOT GREEN  ${name}`); }
}

/* Read the statement out of the real source file. If it is not there,
   the gate fails rather than testing a stale copy of itself. */
function statementFrom(site) {
  const src = fs.readFileSync(path.join(ROOT, site.file), "utf8");
  if (site.exact) {
    // The authorization site's text is a prefix of nothing else in the
    // file only when the trailing backtick is required.
    const hit = src.includes("`" + site.anchor + "`");
    return hit ? site.anchor : null;
  }
  return src.includes(site.anchor) ? site.anchor : null;
}

(async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    line("\nPROPERTY NAME RESOLUTION — three rows, one name");
    line("=".repeat(68));

    await c.query("delete from properties where id = any($1::uuid[])", [MINE]);
    await c.query(
      `insert into properties (id, name, created_at) values
         ($1,$4, now() - interval '3 days'),
         ($2,$4, now() - interval '2 days'),
         ($3,$4, now() - interval '1 day')`, [OLDEST, MIDDLE, NEWEST, NAME]);

    const n = (await c.query("select count(*)::int c from properties where name=$1", [NAME])).rows[0].c;
    ok(`three rows now share "${NAME}"`, n === 3, `saw ${n}`);
    line("");

    line("THE FIVE CALL SITES — each runs the SQL its source file issues");
    line("-".repeat(68));
    for (const site of SITES) {
      const stmt = statementFrom(site);
      if (!stmt) {
        fail++;
        line(`  ✘ ${site.id}`);
        line(`      anchor text NOT FOUND in ${site.file} — the gate is stale, or the`);
        line(`      call site changed. Fix the anchor before trusting any result.`);
        continue;
      }
      const r = await c.query(stmt, [NAME]);
      const got = r.rows[0] ? r.rows[0].id : null;
      const which = got === OLDEST ? "OLDEST" : got === MIDDLE ? "middle" : got === NEWEST ? "newest" : "none";
      isRed(`${site.id} → ${which}`,
            got === OLDEST,
            `${site.note ? site.note + "; " : ""}returned ${r.rows.length} row(s) to the caller, ` +
            `of ${n} that matched. The caller receives NO signal that the other two exist.`);
    }
    line("");

    line("CONTROLS — these must be GREEN. The resolver is not the defect.");
    line("-".repeat(68));
    const { resolvePropertyIdentity } =
      require(path.join(ROOT, "src/identity/property_resolution_service.js"));

    const res = await resolvePropertyIdentity(c, { name_exact: NAME });
    ok("resolvePropertyIdentity(name_exact) → status 'ambiguous'",
       res.status === "ambiguous", `saw "${res.status}"`);
    ok("…and returns all three candidates rather than choosing",
       Array.isArray(res.candidates) && res.candidates.length === 3,
       `saw ${res.candidates ? res.candidates.length : "none"}`);
    ok("…and its receipt names the problem",
       typeof res.receipt === "string" && /3 properties are named/.test(res.receipt),
       `saw "${res.receipt}"`);
    ok("…and it selects NO property", res.property_id === null, `saw ${res.property_id}`);

    /* seed_endpoint.js's shape: resolved-or-null, refusal on anything else. */
    const resolvedOrNull = res.status === "resolved" ? res.property_id : null;
    ok("seed_endpoint.js's shape yields null → the caller refuses",
       resolvedOrNull === null);

    line("");
    line("=".repeat(68));
    line(`  ${red} RED (the defect, as it stands today)   ${pass} control(s) green   ${fail} failed`);
    line("");
    if (fail === 0 && red === 5) {
      line("  Five call sites take the OLDEST of three rows sharing one name, and");
      line("  none of them can tell that the other two matched. The resolver beside");
      line("  them already refuses this exact case, and seed_endpoint.js already");
      line("  consumes that refusal correctly.");
      line("");
      line("  Nothing is fixed here on purpose. This is the before.\n");
    }
  } finally {
    await c.query("delete from properties where id = any($1::uuid[])", [MINE]).catch(() => {});
    await c.end();
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
