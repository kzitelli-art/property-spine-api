#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   READ-ONLY — WHAT ARE THE KEYLESS PROPERTIES, ACTUALLY?

   Migration 150 stamps every property with no canonical_key with the
   reason `predates_canonical_identity_requirement`. That is a true
   statement, but it is a statement about a population nobody has looked
   at. This tool is the looking.

       "Do not backfill production blindly. I want to know what those
        rows actually represent before migration 150 gives them an
        absence reason."

   Run it BEFORE the deploy. It writes NOTHING — no transaction, no
   temp table, no session setting. Every statement is a SELECT, and the
   connection is opened read-only so the database refuses a write even if
   this file is later edited carelessly.

       DATABASE_URL="<production>" node tools/identity/count_keyless_properties.js

   ── WHY IT READS DATABASE_URL DIRECTLY ──────────────────────────────
   Because production is the subject. Registered as PRODUCTION_APPROVED in
   tests/gates/gate_harness_isolation.js with that reason. It is read-only by
   construction, which is what makes the approval defensible.

   ── WHAT IT WILL TELL YOU ───────────────────────────────────────────
   How many rows, and — the part that decides whether the backfill is
   safe — WHAT THEY ARE: do they have addresses (so a key could be
   derived later)? Do they belong to a client? Do they carry real
   operating data, or are they abandoned test rows? Do any of them share
   an address with each other, meaning the population already contains
   duplicates that a canonical key would have prevented?
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Client } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("\n  ✗ REFUSED: DATABASE_URL is not set.");
  console.error("    This reads a real database and will not invent an answer.\n");
  process.exit(2);
}

//  Identity WITHOUT the password, so the receipt can be pasted anywhere.
function identify(u) {
  try {
    const p = new URL(u.replace(/^postgres(ql)?:\/\//, "http://"));
    return { host: p.hostname, port: p.port || "5432", database: p.pathname.replace(/^\//, ""), user: p.username || "(default)" };
  } catch (_) { return { host: "(unparseable)", port: "?", database: "?", user: "?" }; }
}

const line = (s = "") => console.log(s);
const rule = () => line("════════════════════════════════════════════════════════════════");

(async () => {
  const id = identify(url);
  rule();
  line("  READ-ONLY  count_keyless_properties.js");
  line(`  DATABASE   ${id.database}  @  ${id.host}:${id.port}  (user ${id.user})`);
  line(`  READ AT    ${new Date().toISOString()}`);
  line("  WRITES     none — the session is opened read-only");
  rule();

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  //  Belt and braces: even a future edit that added an UPDATE would be
  //  refused by the server rather than by this file's good intentions.
  await client.query("set session characteristics as transaction read only");

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  //  Has 150 already run here? The answer changes what this report means.
  const hasColumn = (await q(
    `select count(*)::int n from information_schema.columns
      where table_name='properties' and column_name='canonical_key_absent_reason'`))[0].n > 0;

  const totals = (await q(
    `select count(*)::int total,
            count(*) filter (where canonical_key is null)::int keyless,
            count(*) filter (where canonical_key is not null)::int keyed
       from properties`))[0];

  line("");
  line("  ── THE POPULATION ──");
  line(`     properties total .................. ${totals.total}`);
  line(`     WITH a canonical key .............. ${totals.keyed}`);
  line(`     WITHOUT one (the backfill set) .... ${totals.keyless}`);
  if (hasColumn) {
    line("");
    line("     ⚠ canonical_key_absent_reason ALREADY EXISTS on this database,");
    line("       so migration 150 has run here. The counts below describe the");
    line("       state AFTER the backfill, not before it.");
    for (const r of await q(
      `select coalesce(canonical_key_absent_reason,'(null)') reason, count(*)::int n
         from properties where canonical_key is null group by 1 order by 2 desc`)) {
      line(`       ${String(r.n).padStart(6)}  ${r.reason}`);
    }
  }

  if (totals.keyless === 0) {
    line("");
    line("  Nothing to backfill. Migration 150's UPDATE will touch 0 rows.");
    rule();
    await client.end();
    process.exit(0);
  }

  //  WHAT THEY ARE. This is the part that decides whether the backfill is
  //  safe, and it is why a bare count would not have been enough.
  const shape = (await q(
    `select count(*) filter (where address is not null and btrim(address) <> '')::int with_address,
            count(*) filter (where address is null or btrim(address) = '')::int without_address,
            count(*) filter (where organization_id is not null)::int with_client,
            count(*) filter (where organization_id is null)::int orphaned
       from properties where canonical_key is null`))[0];

  line("");
  line("  ── WHAT THE KEYLESS ROWS ARE ──");
  line(`     have an address (a key could be derived later) ... ${shape.with_address}`);
  line(`     have NO address .................................. ${shape.without_address}`);
  line(`     belong to a client ............................... ${shape.with_client}`);
  line(`     belong to NO client (the 1A-1 orphans) ........... ${shape.orphaned}`);

  //  Does the population already contain duplicates? A canonical key
  //  would have refused these; they are the cost of not having had one.
  const dupes = await q(
    `select lower(btrim(address)) addr, count(*)::int n
       from properties
      where canonical_key is null and address is not null and btrim(address) <> ''
      group by 1 having count(*) > 1 order by 2 desc limit 20`);
  line("");
  line("  ── ALREADY-DUPLICATED ADDRESSES AMONG THEM ──");
  if (!dupes.length) line("     none — no two keyless properties share an address");
  else {
    line("     ⚠ these addresses appear more than once. A canonical key would");
    line("       have refused the second one. Resolve before deriving keys.");
    for (const d of dupes) line(`       ${String(d.n).padStart(3)}×  ${d.addr}`);
  }

  //  Is any of this real? An abandoned test row and a live building both
  //  read as "keyless"; only one of them matters.
  const live = await q(
    `select p.id, coalesce(p.display_name, p.name) as name, p.address,
            p.organization_id is not null as has_client, p.created_at,
            (select count(*) from units u where u.property_id = p.id)::int units,
            (select count(*) from property_team_assignments a
              where a.property_id = p.id and a.active) ::int staff
       from properties p
      where p.canonical_key is null
      order by units desc, staff desc, p.created_at asc
      limit 40`);

  line("");
  line("  ── EVERY KEYLESS PROPERTY (busiest first, max 40) ──");
  line("     units  staff  client  created     name / address");
  for (const r of live) {
    line(`     ${String(r.units).padStart(5)}  ${String(r.staff).padStart(5)}  ` +
         `${r.has_client ? "  yes " : "  NO  "}  ${String(r.created_at).slice(0, 10)}  ` +
         `${r.name}${r.address ? "  ·  " + r.address : "  ·  (no address)"}`);
  }
  if (totals.keyless > 40) line(`     … and ${totals.keyless - 40} more`);

  const operating = live.filter((r) => r.units > 0 || r.staff > 0).length;
  line("");
  line("  ── READ THIS BEFORE DEPLOYING ──");
  line(`     Migration 150 will stamp ${totals.keyless} row(s) with`);
  line("     'predates_canonical_identity_requirement'. That is true of all of");
  line("     them, and it is all the backfill claims — it invents no identity");
  line("     and changes no canonical_key.");
  line("");
  if (operating > 0) {
    line(`     ${operating} of the rows shown carry units or staff, so they are`);
    line("     REAL OPERATING PROPERTIES, not abandoned test rows. Those are the");
    line("     ones Build 1B's activation will surface as 'identity needs");
    line("     confirmation'. Decide whether you want that list to be that long.");
  } else {
    line("     None of the rows shown carries units or staff, which suggests the");
    line("     keyless population is test/abandoned rather than operating. Confirm");
    line("     that by eye before treating it as harmless.");
  }
  if (dupes.length) {
    line("");
    line(`     ⚠ ${dupes.length} address(es) are already duplicated in this set.`);
    line("       The backfill does not make that worse, but deriving keys later");
    line("       will collide on them. That is a decision, not a migration.");
  }

  rule();
  await client.end();
  process.exit(0);
})().catch(async (e) => {
  console.error("\n  ✗ READ FAILED: " + (e && e.message ? e.message : e));
  console.error("    Nothing was written. Re-run once the cause is understood.\n");
  process.exit(1);
});
