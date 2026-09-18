#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    skyline_grant_staff_context.js — CLEAR THE ONE BLOCKER, THROUGH THE
    MECHANISM THAT OWNS IT.

    skyline_authority_dryrun.js reported eight preconditions passing and one
    failing:

        ✗ person_entitled_to_property
          The staff context is anchored to another property.

    Kameron Zitelli is already governed staff — classified, bridge-linked,
    holding an active staff context. That context is anchored to Property
    Spine Demo Building. Skyline needs its own.

    ── WHY NOT AN INSERT ────────────────────────────────────────────────
    staffbridge.js OWNS person_contexts. grantStaffContext() refuses to be
    the act that first makes someone staff (a person with no active context
    gets a 409 pointing at classify/link), reports a replay rather than
    duplicating, and records who performed it. An INSERT here would produce
    a row that looks identical and skips all of that — the exact defect
    class where a canonical mechanism exists and the real path goes around
    it.

    ── DRY RUN BY DEFAULT ───────────────────────────────────────────────
    Nothing is written without --apply. The dry run resolves both ids,
    prints the names they belong to, and stops. Ids are ARGUMENTS, never
    hardcoded: a 36-character identifier retyped from a screen is a
    transcription risk, and this tool would rather be told and then say what
    it heard.

        node tools/release/skyline_grant_staff_context.js \
          --person <uuid> --property <uuid> --by <login-uuid> \
          --reviewer <distinct-authorized-login-uuid>

        ... same command with --apply to write.

    After applying it re-asks resolveAuthority, so the blocker either
    cleared or it did not, in the same output. A write whose effect is
    reported by the thing that wanted it is worth more than a success line.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { databaseSsl } = require(path.join(ROOT, "src/shared/database_ssl"));
const { resolveAuthority } = require(path.join(ROOT, "src/identity/authority_resolution.js"));
const buildStaffBridge = require(path.join(ROOT, "src/identity/staffbridge.js"));

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes("--apply");
const PERSON = arg("person"), PROPERTY = arg("property"), BY = arg("by");
const REVIEWER = arg("reviewer");
const REASON = arg("reason") || "entitle KZ at Skyline so pricing authority can be granted through the resolver";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const [n, v] of [["person", PERSON], ["property", PROPERTY], ["by", BY], ["reviewer", REVIEWER]]) {
  if (!v)         { console.error(`--${n} is required.`); process.exit(64); }
  if (!UUID.test(v)) { console.error(`--${n} is not a uuid: ${v}`); process.exit(64); }
}

const pool = new Pool({ connectionString: url, ssl: databaseSsl(url) });
const rule = () => console.log("  " + "─".repeat(72));

(async () => {
  console.log(`\n  SKYLINE STAFF CONTEXT · ${APPLY ? "APPLY — THIS WRITES" : "DRY RUN — writes nothing"}`);
  rule();

  //  ── say what the ids are, before doing anything with them ──
  const p  = (await pool.query("select id, name, lifecycle_status from persons where id=$1", [PERSON])).rows[0];
  const pr = (await pool.query("select id, name, address from properties where id=$1", [PROPERTY])).rows[0];
  const by = (await pool.query("select id, email, person_id from users where id=$1", [BY])).rows[0];
  if (!p)  { console.error(`  no person ${PERSON}`);   await pool.end(); process.exit(1); }
  if (!pr) { console.error(`  no property ${PROPERTY}`); await pool.end(); process.exit(1); }
  if (!by) { console.error(`  no login ${BY}`);         await pool.end(); process.exit(1); }
  console.log(`  person    ${p.name}   (${p.lifecycle_status || "no lifecycle"})`);
  console.log(`  property  ${pr.name}   ${pr.address || "(no address)"}`);
  console.log(`  performed by login  ${by.email}`);

  const ctx = (await pool.query(
    `select id, property_id from person_contexts
      where person_id=$1 and context_type='staff' and active_to is null`, [PERSON])).rows;
  console.log(`\n  staff contexts open today: ${ctx.length}`);
  for (const c of ctx) {
    const at = c.property_id
      ? (await pool.query("select name from properties where id=$1", [c.property_id])).rows[0]
      : null;
    console.log(`     ${c.property_id ? "scoped to " + (at ? at.name : c.property_id) : "UNSCOPED — covers every property"}`);
  }

  if (!APPLY) {
    console.log(`\n  WOULD: widen ${p.name}'s staff entitlement to include ${pr.name}.`);
    console.log(`  Re-run with --apply to write it.`);
    rule(); console.log("  dry run complete — nothing was written."); rule(); console.log();
    await pool.end(); return;
  }

  //  ── the canonical owner performs the write, inside one transaction ──
  const bridge = buildStaffBridge({ pool });
  const c = await pool.connect();
  let out;
  try {
    await c.query("begin");
    out = await bridge._service.grantStaffContext(c, {
      person_id: PERSON, property_id: PROPERTY,
      performed_by_user_id: BY, reason_detail: REASON,
    });
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    console.error(`\n  REFUSED (nothing written): ${e.message}`);
    c.release(); await pool.end(); process.exit(1);
  }
  c.release();

  console.log(`\n  ── what the mechanism reports ──`);
  console.log(`     ${out.replayed ? "REPLAY (no new row)" : "WRITTEN"}`);
  console.log(`     ${out.receipt}`);

  //  ── ask the thing that wanted it whether it got what it needed ──
  console.log(`\n  ── re-asking resolveAuthority ──`);
  const after = await resolveAuthority(pool, {
    spec: { user_id: BY, person_id: PERSON, property_id: PROPERTY,
            requested_role: "asset_manager", reviewer_user_id: REVIEWER,
            reason: "post-grant verification" },
    apply: false,
  });
  console.log(`     WOULD APPLY  ${after.would_apply ? "YES" : "NO"}`);
  if ((after.blocking || []).length) console.log(`     blocking     ${after.blocking.join(", ")}`);
  else console.log(`     blocking     (none)`);
  for (const c2 of (after.receipt && after.receipt.evidence) || []) {
    console.log(`     ${c2.passed ? "✓" : "✗"} ${String(c2.id).padEnd(30)} ${c2.detail || ""}`);
  }

  rule();
  console.log(after.would_apply
    ? "  BLOCKER CLEARED — the resolver would now grant asset_manager. Step 2 is next."
    : "  STILL BLOCKED — do not proceed to step 2; the reason is named above.");
  rule(); console.log();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
