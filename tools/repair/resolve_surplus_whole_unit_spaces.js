#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   resolve_surplus_whole_unit_spaces.js — PLATFORM REPAIR, NOT A FEATURE.

   ── WHAT IS BROKEN ──────────────────────────────────────────────────
   `trg_unit_space` (001_baseline) fires AFTER INSERT ON units and inserts
   one '(whole unit)' space, unconditionally. The invariant is right — a
   lease must always have somewhere to attach — but on a by-the-bed
   property that placeholder sits BESIDE the real beds, and every leasable
   denominator downstream counts it.

   `src/tenancy/inventory_materialization.js` fixed this for loads that go
   through it: on a clean load the placeholder is still pristine and is
   CONSUMED as the first source-named position. This tool exists for the
   properties that were loaded BEFORE that writer existed, where the beds
   were created beside the placeholder instead of out of it.

   On those, the canonical writer deliberately REFUSES:

       SURPLUS_PLACEHOLDER — "Unit already has a 'Room1' position, so its
       '(whole unit)' placeholder is surplus and cannot be consumed.
       Nothing was changed."

   That refusal is correct and must stay. Its own comment says why: a
   partial load, a hand-edit or two importers disagreeing is "a question
   for a person, not a row for an importer to remove." This tool is how a
   person answers that question deliberately, with a receipt — it is NOT
   the importer learning to delete.

   ── WHAT IT WILL AND WILL NOT DO ────────────────────────────────────
   WILL   remove a '(whole unit)' space when the unit ALSO carries at
          least one source-named position, and only when that placeholder
          is referenced by NOTHING.
   WILL   refuse, per row, naming what holds it — never skip quietly.
   WON'T  touch a unit whose only position is the placeholder. On a
          by-unit property that placeholder IS the inventory, and a unit
          with no rentable position at all breaks the invariant the
          trigger exists to protect.
   WON'T  decide anything about units that were never real. A duplicate or
          stale UNIT is a different question with no canonical rule, and
          inventing one here would be the drift this tool is trying to
          avoid. It is out of scope on purpose.
   WON'T  write without --apply.

   ── PRISTINE IS ASKED OF THE CATALOG, NOT OF A LIST ─────────────────
   The reference check is `referencesTo` IMPORTED from the canonical
   module — the same function the writer's own guard uses, reading
   pg_constraint at runtime. Not a copy, and not a list maintained here: a
   list would be wrong the first time somebody adds a table with a
   space_id, and it would be wrong silently.

   ── CLASSIFICATION ──────────────────────────────────────────────────
   CLASS 4 — temporary platform repair.
   REMOVED WHEN: no property in production has a '(whole unit)' space on a
   unit that also carries a source-named position. That condition is a
   query, not a judgement:

     select count(*) from spaces p join units u on u.id = p.unit_id
      where p.space_label = '(whole unit)'
        and exists (select 1 from spaces s
                     where s.unit_id = u.id and s.space_label <> '(whole unit)');

   When that returns 0 for every property, delete this file. It does not
   become a feature and it does not grow a route.

   ── RUN ─────────────────────────────────────────────────────────────
     DATABASE_URL="…" node tools/repair/resolve_surplus_whole_unit_spaces.js \
       --property <uuid>              # inspect; writes nothing
     DATABASE_URL="…" node tools/repair/resolve_surplus_whole_unit_spaces.js \
       --property <uuid> --apply      # one transaction, all or nothing
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Pool } = require("pg");
const { referencesTo, PLACEHOLDER_LABEL } = require("../../src/tenancy/inventory_materialization.js");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true);
};
const APPLY = argv.includes("--apply");
const PROPERTY = flag("property");

function die(msg) { console.error("\n  ✗ " + msg + "\n"); process.exit(2); }

if (!process.env.DATABASE_URL) die("DATABASE_URL is not set.");
if (!PROPERTY || PROPERTY === true) {
  die("--property <uuid> is required. This is repair, scoped deliberately to one\n" +
      "    property at a time — there is no --all, because a sweep is not a decision.");
}

/*  candidateSurplusPlaceholders — the GENERAL predicate.
 *
 *  A placeholder is surplus when its unit also carries a source-named
 *  position. That is derived from the inventory itself: no property name,
 *  no import_batch_id, nothing that would make this a Skyline patch.
 *
 *  It also naturally excludes the units this tool must not touch — a unit
 *  whose only position is the placeholder has no source-named sibling and
 *  never appears here.
 */
async function candidateSurplusPlaceholders(client, propertyId) {
  return (await client.query(
    `select p.id as space_id, u.id as unit_id, u.unit_number,
            p.position_kind, p.import_batch_id,
            (select count(*)::int from spaces s
              where s.unit_id = u.id and s.space_label <> $2) as named_siblings,
            (select count(*)::int from spaces s where s.unit_id = u.id) as positions_now
       from spaces p
       join units u on u.id = p.unit_id
      where u.property_id = $1
        and p.space_label = $2
        and exists (select 1 from spaces s
                     where s.unit_id = u.id and s.space_label <> $2)
      order by u.unit_number, p.id`,
    [propertyId, PLACEHOLDER_LABEL])).rows;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  let exitCode = 0;
  try {
    const prop = (await client.query(
      "select id, name, address from properties where id = $1", [PROPERTY])).rows[0];
    if (!prop) die(`No property ${PROPERTY}.`);

    const before = (await client.query(
      `select count(*)::int as n from spaces s join units u on u.id = s.unit_id
        where u.property_id = $1`, [PROPERTY])).rows[0].n;

    const candidates = await candidateSurplusPlaceholders(client, PROPERTY);

    console.log("\n  ── SURPLUS '(whole unit)' PLACEHOLDERS ────────────────");
    console.log(`     property        ${prop.name}  ·  ${prop.address}`);
    console.log(`     id              ${prop.id}`);
    console.log(`     spaces now      ${before}`);
    console.log(`     candidates      ${candidates.length}`);
    console.log(`     mode            ${APPLY ? "APPLY (writes)" : "INSPECT (writes nothing)"}`);
    console.log("  ───────────────────────────────────────────────────────\n");

    if (!candidates.length) {
      console.log("  Nothing to resolve. Every '(whole unit)' space on this property is\n" +
                  "  its unit's only position, which is what a by-unit unit should look like.\n");
      return;
    }

    //  Pristine is checked for EVERY candidate before anything is removed,
    //  so a report is a report of the whole set rather than of the prefix
    //  that happened to be clean.
    const pristine = [], held = [];
    for (const c of candidates) {
      const holders = await referencesTo(client, c.space_id);
      //  Never leave a unit with zero rentable positions, whatever the
      //  predicate said. Asserted, not assumed.
      if (c.positions_now - 1 < 1 || c.named_siblings < 1) {
        held.push({ ...c, holders: ["would leave the unit with no rentable position"] });
      } else if (holders.length) {
        held.push({ ...c, holders });
      } else {
        pristine.push(c);
      }
    }

    if (held.length) {
      exitCode = 1;
      console.log(`  ✗ ${held.length} placeholder(s) are NOT pristine. Nothing was removed for these,`);
      console.log("    and this tool does not decide what a human must:\n");
      for (const h of held) {
        console.log(`      unit ${String(h.unit_number).padEnd(12)} space ${h.space_id}`);
        for (const x of h.holders) console.log(`        held by  ${x}`);
      }
      console.log("");
    }

    console.log(`  ${pristine.length} placeholder(s) are referenced by nothing:\n`);
    for (const p of pristine) {
      console.log(`      unit ${String(p.unit_number).padEnd(12)} space ${p.space_id}` +
                  `  (unit keeps ${p.named_siblings} named position(s))`);
    }
    console.log("");

    if (!APPLY) {
      console.log("  INSPECT ONLY — nothing was written. Re-run with --apply to remove the\n" +
                  "  pristine ones. The non-pristine ones will still be refused.\n");
      return;
    }
    if (!pristine.length) {
      console.log("  Nothing pristine to remove.\n");
      return;
    }

    //  ONE TRANSACTION. A partial repair is a new inconsistent state.
    await client.query("begin");
    const ids = pristine.map((p) => p.space_id);
    //  The guard is "a sibling MUST survive". Written the other way round
    //  first — `not exists (a sibling)` — which would only ever delete a
    //  unit's LAST position, the one case this must never touch. It matched
    //  nothing, the count check refused, and the transaction rolled back:
    //  the guard failed in the safe direction, and the proof caught it.
    const del = await client.query(
      `delete from spaces where id = any($1::uuid[]) and space_label = $2
         and exists (select 1 from spaces s
                      where s.unit_id = spaces.unit_id and s.id <> spaces.id)
        returning id`, [ids, PLACEHOLDER_LABEL]);
    //  The guarded DELETE above refuses to remove a unit's last space even
    //  if everything upstream got it wrong. If it removed fewer than we
    //  authorised, that disagreement is a stop, not a rounding difference.
    if (del.rowCount !== ids.length) {
      await client.query("rollback");
      die(`Authorised ${ids.length} removals; the guarded delete matched ${del.rowCount}. ` +
          `Rolled back — nothing changed.`);
    }
    const after = (await client.query(
      `select count(*)::int as n from spaces s join units u on u.id = s.unit_id
        where u.property_id = $1`, [PROPERTY])).rows[0].n;
    await client.query("commit");

    console.log("  ── APPLIED ────────────────────────────────────────────");
    console.log(`     removed         ${del.rowCount}`);
    console.log(`     spaces before   ${before}`);
    console.log(`     spaces after    ${after}`);
    console.log(`     refused         ${held.length}`);
    console.log("  ───────────────────────────────────────────────────────");
    console.log("\n  This resolved the SURPLUS_PLACEHOLDER condition only. It says nothing");
    console.log("  about whether every remaining unit is a real unit — that is a separate");
    console.log("  question with no canonical rule, and this tool did not answer it.\n");
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    console.error("\n  ✗ FAILED — nothing committed.");
    console.error("    " + (e && e.message ? e.message : String(e)) + "\n");
    exitCode = 2;
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(exitCode);
}

main();
