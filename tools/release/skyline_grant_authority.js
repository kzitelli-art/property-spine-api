#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    skyline_grant_authority.js — STEP 2: THE AUTHORITY WRITE ITSELF.

    skyline_authority_dryrun.js is READ ONLY and stays that way — a tool
    whose header promises it writes nothing should not grow a flag that
    makes it write. This is the apply path, kept separate.

    resolveAuthority() performs it. With apply = true it does ONE write: an
    `assignments` row carrying provenance — the reviewer, the reason, and
    when it resolved. Classification and linking are deliberately not
    performed here; they are separate attributable acts with their own
    trails.

    ── TWO-PARTY REVIEW IS ENFORCED ─────────────────────────────────────
    --reviewer is required. The resolver verifies that it names a different
    governed human who holds may_manage_concession_authority at this property.
    A login id and reason alone are no longer treated as review.

    ── DRY RUN BY DEFAULT ───────────────────────────────────────────────
        node tools/release/skyline_grant_authority.js \
          --person <uuid> --property <uuid> --by <login-uuid> --reviewer <login-uuid>

        ... same command with --apply to write.

    After applying it asks pricingAuthority() — the RUNTIME check, which
    reads assignments and never consults person_contexts — whether the
    verbs are actually held. The resolver saying it granted something and
    the product agreeing that it did are two different claims.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { databaseSsl } = require(path.join(ROOT, "src/shared/database_ssl"));
const { resolveAuthority } = require(path.join(ROOT, "src/identity/authority_resolution.js"));
const { pricingAuthority } = require(path.join(ROOT, "src/money/pricing_authority.js"));

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes("--apply");
const PERSON = arg("person"), PROPERTY = arg("property"), BY = arg("by");
const REVIEWER = arg("reviewer");
const ROLE = arg("role") || "asset_manager";
const REASON = arg("reason") ||
  "establish Skyline pricing authority so the governed publication workflow can run";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const [n, v] of [["person", PERSON], ["property", PROPERTY], ["by", BY], ["reviewer", REVIEWER]]) {
  if (!v)            { console.error(`--${n} is required.`); process.exit(64); }
  if (!UUID.test(v)) { console.error(`--${n} is not a uuid: ${v}`); process.exit(64); }
}

const pool = new Pool({ connectionString: url, ssl: databaseSsl(url) });
const rule = () => console.log("  " + "─".repeat(72));
const verbs = (a) => ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing",
                      "may_manage_concession_authority"]
  .map((v) => `${a && a[v] ? "✓" : "✗"} ${v}`).join("   ");

(async () => {
  console.log(`\n  SKYLINE PRICING AUTHORITY · ${APPLY ? "APPLY — THIS WRITES" : "DRY RUN — writes nothing"}`);
  rule();

  const p  = (await pool.query("select id, name from persons where id=$1", [PERSON])).rows[0];
  const pr = (await pool.query("select id, name from properties where id=$1", [PROPERTY])).rows[0];
  const by = (await pool.query("select id, email from users where id=$1", [BY])).rows[0];
  const rv = (await pool.query("select id, email from users where id=$1", [REVIEWER])).rows[0];
  if (!p || !pr || !by || !rv) {
    console.error("  one of person / property / by / reviewer does not exist"); await pool.end(); process.exit(1);
  }
  console.log(`  grant     ${ROLE}  to  ${p.name}`);
  console.log(`  at        ${pr.name}`);
  console.log(`  by        ${by.email}`);
  console.log(`  reviewer  ${rv.email}`);
  console.log(`\n  ── authority held BEFORE ──`);
  const before = await pricingAuthority(pool, { property_id: PROPERTY, person_id: PERSON });
  console.log(`     ${verbs(before)}`);

  if (!APPLY) {
    const dry = await resolveAuthority(pool, {
      spec: { user_id: BY, person_id: PERSON, property_id: PROPERTY, requested_role: ROLE,
              reviewer_user_id: REVIEWER, reason: REASON },
      apply: false });
    console.log(`\n  ── the resolver's verdict ──`);
    console.log(`     WOULD APPLY  ${dry.would_apply ? "YES" : "NO"}`);
    if ((dry.blocking || []).length) console.log(`     blocking     ${dry.blocking.join(", ")}`);
    for (const c of (dry.receipt && dry.receipt.evidence) || []) {
      console.log(`     ${c.passed ? "✓" : "✗"} ${String(c.id).padEnd(30)} ${c.detail || ""}`);
    }
    console.log(dry.would_apply
      ? `\n  WOULD: grant ${ROLE} to ${p.name} at ${pr.name}. Re-run with --apply.`
      : `\n  WOULD NOT APPLY — fix what is blocking before adding --apply.`);
    rule(); console.log("  dry run complete — nothing was written."); rule(); console.log();
    await pool.end(); return;
  }

  let out;
  try {
    out = await resolveAuthority(pool, {
      spec: { user_id: BY, person_id: PERSON, property_id: PROPERTY, requested_role: ROLE,
              reviewer_user_id: REVIEWER, reason: REASON },
      apply: true });
  } catch (e) {
    console.error(`\n  REFUSED (nothing written): ${e.message}`);
    await pool.end(); process.exit(1);
  }
  console.log(`\n  ── what the resolver reports ──`);
  console.log(`     mode         ${out.mode || "(none)"}`);
  console.log(`     disposition  ${out.disposition || "(none)"}`);

  //  The product's own reader, not the resolver's word for it.
  console.log(`\n  ── authority held AFTER, per the RUNTIME check ──`);
  const after = await pricingAuthority(pool, { property_id: PROPERTY, person_id: PERSON });
  console.log(`     ${verbs(after)}`);

  rule();
  console.log(after && after.may_publish_pricing
    ? "  GRANTED — pricingAuthority now reports may_publish_pricing. Step 3 is next."
    : "  NOT EFFECTIVE — the resolver wrote, but the runtime check still denies. Stop here.");
  rule(); console.log();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
