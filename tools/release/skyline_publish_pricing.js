#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    skyline_publish_pricing.js — STEP 4: THE NUMBER A PROSPECT HEARS.

    saveDraft → submitReview → publishVersion, the canonical workflow, with
    previewPublication asked first so the contract reports its blockers
    before anything is written.

    ── THE RENTS LIVE HERE, NOT IN A SHELL ARGUMENT ─────────────────────
    They are business truth confirmed by ownership on 2026-08-20, so they
    belong in a file where a diff reviews them. Passed on a command line a
    mistyped digit publishes a wrong price to prospects and nobody sees the
    keystroke afterwards. Here the dry run echoes them for confirmation and
    git holds the history of what was proposed and by whom.

    ── ONE TERM ONLY, DELIBERATELY ──────────────────────────────────────
    12 months is published. 7- and 5-month leases are short, carry +$150,
    and are NOT published: they are not preferred inventory and the premium
    is upsold by a person. Asking the adapter for an unpublished term
    returns term_not_published — an honest handoff, which is where a
    negotiation belongs. See docs/SKYLINE_OPERATING_FACTS.md.

    ── reason_code IS NOT SET, AND THAT IS NOT AN OVERSIGHT ─────────────
    property_pricing_versions carries a reason_code vocabulary and the
    canonical lifecycle never writes it. Rather than reach around
    pricing_lifecycle.js to set a field it does not own, this tool leaves it
    NULL and records the gap. Publishing through the mechanism and then
    patching the row behind it would be the same defect class this whole
    sequence exists to avoid.

        node tools/release/skyline_publish_pricing.js --property <uuid> --person <uuid>
        ... same command with --apply to write.

    After applying it asks quotablePricing() — the adapter the leasing agent
    actually calls — what a prospect would now be told.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { databaseSsl } = require(path.join(ROOT, "src/shared/database_ssl"));
const { pricingAuthority } = require(path.join(ROOT, "src/money/pricing_authority.js"));
const { saveDraft, submitReview, publishVersion } = require(path.join(ROOT, "src/money/pricing_lifecycle.js"));
const { previewPublication } = require(path.join(ROOT, "src/money/pricing_publication_preview.js"));
const { quotablePricing } = require(path.join(ROOT, "src/agent/pricing_adapter.js"));
const { effectivePropertyPricing } = require(path.join(ROOT, "src/money/effective_pricing.js"));

//  ════ CONFIRMED BY OWNERSHIP 2026-08-20 — PER BED, PER MONTH ════
//  Renewal equals new lease. Effective for Spring 2027 and 2027-28.
const RENTS = [
  { code: "2BR",       base_rent: 850, renewal_rent: 850 },
  { code: "3BR-1BA",   base_rent: 750, renewal_rent: 750 },
  { code: "3BR-1.5BA", base_rent: 775, renewal_rent: 775 },
];
const TERM_MONTHS = 12;

const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes("--apply");
const PROPERTY = arg("property"), PERSON = arg("person");
const EFFECTIVE_FROM = arg("effective-from") || "2027-01-01";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(64); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
for (const [n, v] of [["property", PROPERTY], ["person", PERSON]]) {
  if (!v || !UUID.test(v)) { console.error(`--${n} must be a uuid`); process.exit(64); }
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(EFFECTIVE_FROM)) { console.error("--effective-from must be YYYY-MM-DD"); process.exit(64); }

const pool = new Pool({ connectionString: url, ssl: databaseSsl(url) });
const rule = () => console.log("  " + "─".repeat(72));

(async () => {
  console.log(`\n  SKYLINE PRICING · ${APPLY ? "APPLY — THIS PUBLISHES" : "DRY RUN — writes nothing"}`);
  rule();

  const pr = (await pool.query("select name from properties where id=$1", [PROPERTY])).rows[0];
  const pn = (await pool.query("select name from persons where id=$1", [PERSON])).rows[0];
  if (!pr || !pn) { console.error("  property or person not found"); await pool.end(); process.exit(1); }
  console.log(`  property   ${pr.name}`);
  console.log(`  publisher  ${pn.name}`);
  console.log(`  effective  ${EFFECTIVE_FROM}`);

  const auth = await pricingAuthority(pool, { property_id: PROPERTY, person_id: PERSON });
  console.log(`  authority  prepare=${!!auth.may_prepare_pricing} review=${!!auth.may_review_pricing} publish=${!!auth.may_publish_pricing}`);
  if (!auth.may_publish_pricing) {
    console.error("\n  REFUSING: this person cannot publish pricing here. Step 2 first."); await pool.end(); process.exit(1);
  }

  //  ── resolve every rent to a real unit type, or refuse ──
  const types = (await pool.query(
    "select id, code, label from property_unit_types where property_id=$1 order by sort_order", [PROPERTY])).rows;
  console.log(`\n  ── the sheet ──`);
  const terms = []; let unresolved = 0;
  for (const r of RENTS) {
    const t = types.find((x) => x.code === r.code);
    if (!t) { unresolved++; console.log(`     ✗ ${r.code.padEnd(11)} NO SUCH UNIT TYPE at this property`); continue; }
    console.log(`     ✓ ${r.code.padEnd(11)} $${String(r.base_rent).padEnd(5)}/bed/mo   ${TERM_MONTHS}-month   renewal $${r.renewal_rent}   ${t.label}`);
    terms.push({ unit_type_id: t.id, lease_term_months: TERM_MONTHS,
                 base_rent: r.base_rent, renewal_rent: r.renewal_rent, offer_state: "offered" });
  }
  //  Silence cannot publish: a type present at the property but absent from
  //  the sheet is refused by the workflow, and is refused earlier here.
  const unaddressed = types.filter((t) => !RENTS.some((r) => r.code === t.code));
  for (const t of unaddressed) { unresolved++; console.log(`     ✗ ${t.code.padEnd(11)} EXISTS AT THIS PROPERTY BUT IS NOT PRICED`); }
  if (unresolved) {
    console.error(`\n  REFUSING: ${unresolved} type(s) unmatched. The sheet and the inventory must agree exactly.`);
    await pool.end(); process.exit(1);
  }

  const proposal = { publisher_person_id: PERSON, effective_from: EFFECTIVE_FROM, terms };

  console.log(`\n  ── the publication contract, asked before anything is written ──`);
  const pv = await previewPublication(pool, { property_id: PROPERTY, proposal });
  const blockers = (pv.blockers || []).map((b) => b.code);
  console.log(`     would_publish  ${pv.would_publish}`);
  console.log(`     blockers       ${blockers.join(", ") || "(none)"}`);
  const onlyReview = blockers.length === 1 && blockers[0] === "no_reviewed_receipt";
  if (blockers.length && !onlyReview) {
    console.error(`\n  REFUSING: blocked by something other than the pending review.`);
    await pool.end(); process.exit(1);
  }
  if (onlyReview) console.log(`     (no_reviewed_receipt is expected — the review happens below)`);

  if (!APPLY) {
    console.log(`\n  WOULD: publish these three rents effective ${EFFECTIVE_FROM}.`);
    console.log(`  Re-run with --apply to write.`);
    rule(); console.log("  dry run complete — nothing was written."); rule(); console.log();
    await pool.end(); return;
  }

  console.log(`\n  ── draft → review → publish ──`);
  let draft, receipt, published;
  try {
    draft = await saveDraft(pool, { property_id: PROPERTY, person_id: PERSON, proposal });
    const draftId = draft.draft_version_id || draft.version_id || draft.id;
    console.log(`     draft      ${draftId}`);
    receipt = await submitReview(pool, { property_id: PROPERTY, person_id: PERSON,
      draft_version_id: draftId, proposal, decision: "approved",
      note: "Skyline asking rents confirmed by ownership 2026-08-20; one authorized asset manager is sufficient per the recorded ruling." });
    const receiptId = receipt.review_receipt_id || receipt.receipt_id || receipt.id;
    console.log(`     review     ${receiptId}  approved`);
    //  receipt_reviewed is a PROPOSAL FLAG the preview takes on trust. The
    //  real gate is inside publishVersion, which re-reads the receipt, checks
    //  the decision is `approved`, and compares proposalDigest — so an edited
    //  sheet cannot publish wearing an old approval. It is not part of the
    //  digest, so setting it does not invalidate the review just recorded.
    //  Omitting it refuses with no_reviewed_receipt even though the receipt
    //  exists and was approved seconds earlier.
    published = await publishVersion(pool, { property_id: PROPERTY, person_id: PERSON,
      draft_version_id: draftId, proposal: { ...proposal, receipt_reviewed: true },
      review_receipt_id: receiptId, dry_run: false });
    console.log(`     published  ${published.version_id || published.id || JSON.stringify(published).slice(0,60)}`);
  } catch (e) {
    console.error(`\n  REFUSED at that step (nothing further written): ${e.message}`);
    await pool.end(); process.exit(1);
  }

  //  ── ⚠ A FUTURE effective_from MEANS SILENCE UNTIL THAT DATE ──────
  //  effective_from is when this SHEET is in force for quoting. It is not
  //  the lease start date — that is the term, and it lives on the lease.
  //  effectivePropertyPricing selects `effective_from <= as_of`, so a sheet
  //  dated ahead of today is invisible to the agent until then, and every
  //  prospect asking a price before that gets an honest handoff instead of
  //  a number. That is correct behaviour and it is easy to publish by
  //  accident, so it is stated rather than discovered.
  const TODAY = new Date().toISOString().slice(0, 10);
  const future = EFFECTIVE_FROM > TODAY;
  if (future) {
    console.log(`\n  ⚠ DATED AHEAD. This sheet is in force from ${EFFECTIVE_FROM}; today is ${TODAY}.`);
    console.log(`    Until then the agent quotes NOTHING for this property and hands off.`);
    console.log(`    If prospects are being quoted now — 2027-28 pre-leasing, spring tours —`);
    console.log(`    the sheet needs an effective_from on or before today.`);
  }

  //  ── what a prospect is told, per the agent's own adapter ──
  //  Verified twice when the sheet is dated ahead: as of today, and as of the
  //  date it comes into force. The seam is opts.picture, which the adapter
  //  exposes precisely so a preview runs the same refusal path as the live
  //  call rather than a reimplementation of it.
  const asOfPicture = await effectivePropertyPricing(pool, { property_id: PROPERTY, as_of: EFFECTIVE_FROM });
  console.log(`\n  ── what the leasing agent quotes ON ${EFFECTIVE_FROM} ──`);
  let quoted = 0;
  for (const r of RENTS) {
    const t = types.find((x) => x.code === r.code);
    const q = await quotablePricing(pool, { property_id: PROPERTY, unit_type_id: t.id, intent: "new_lease" },
                                    { picture: asOfPicture });
    if (q.quotable && Number(q.rent) === r.base_rent) { quoted++;
      console.log(`     ✓ ${r.code.padEnd(11)} quotes $${q.rent}/mo on a ${q.lease_term_months}-month term   basis=${q.proof && q.proof.basis}`);
    } else {
      console.log(`     ✗ ${r.code.padEnd(11)} ${q.quotable ? "quoted $" + q.rent + " (expected $" + r.base_rent + ")" : "NOT QUOTABLE: " + q.reason}`);
    }
  }
  const t0 = types.find((x) => x.code === "2BR");
  const short = await quotablePricing(pool, { property_id: PROPERTY, unit_type_id: t0.id, lease_term_months: 5 },
                                      { picture: asOfPicture });
  console.log(`     ${short.quotable ? "✗" : "✓"} 5-month term  ${short.quotable ? "QUOTED $" + short.rent + " — SHOULD HAVE REFUSED" : short.reason}`);

  if (future) {
    const now = await quotablePricing(pool, { property_id: PROPERTY, unit_type_id: t0.id, intent: "new_lease" });
    console.log(`\n  ── and what it quotes TODAY (${TODAY}) ──`);
    console.log(`     ${now.quotable ? "$" + now.rent : "nothing — " + now.reason}`);
  }

  rule();
  console.log(quoted === RENTS.length && !short.quotable
    ? `  PUBLISHED — on ${EFFECTIVE_FROM} the agent quotes the governed rents and refuses the unpublished term.`
    : "  PUBLISHED BUT THE QUOTES DISAGREE — read the lines above before telling anyone a price.");
  rule(); console.log();
  await pool.end();
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
