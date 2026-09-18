/*  ════════════════════════════════════════════════════════════════════
    skyline_pricing_publication.e2e.js — THE REAL GOVERNED PUBLICATION,
    DRIVEN END TO END.

    Every green leasing fixture in this repository creates pricing by
    INSERTing pricing_terms and flipping a version to 'published'. That
    proves the fixture. The business act standing between Skyline and
    activation is the publication WORKFLOW — draft, review, publish — and
    it had never been exercised by any proof here.

    So: authority through the governed rail, unit types through the
    canonical mapping tool, then saveDraft → submitReview → publishVersion,
    then the prospect-facing resolver, and finally the hostile side that
    matters most — that the number a prospect could be quoted did NOT come
    from units.market_rent.

    ⚠ THE RENT AMOUNTS HERE ARE MECHANISM-PROVING PLACEHOLDERS ON A
    DISPOSABLE DATABASE. They are not Skyline's rents, they are not
    proposed as Skyline's rents, and nothing here is fit to be copied into
    production. What Skyline actually charges is a business ruling.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { resolveAuthority } = require(path.join(ROOT, "src/identity/authority_resolution.js"));
const { pricingAuthority } = require(path.join(ROOT, "src/money/pricing_authority.js"));
const { saveDraft, submitReview, publishVersion } = require(path.join(ROOT, "src/money/pricing_lifecycle.js"));
const { previewPublication } = require(path.join(ROOT, "src/money/pricing_publication_preview.js"));
const { resolveSpaceEconomics } = require(path.join(ROOT, "src/money/effective_pricing.js"));
const { establishAuthorizedReviewer } = require(path.join(
  ROOT, "tests/support/authority_reviewer_fixture.js"));

const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
let pass = 0, fail = 0, firstRed = null;
const ok  = (l, d="") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d="") => { fail++; if (!firstRed) firstRed = `${l}${d ? " — " + d : ""}`;
                           console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };

const LEGACY_SENTINEL = 999999;   // what units.market_rent will carry
const PLAN = [
  { code: "STU00016", units: 56, beds: 2, bedrooms: 2, bathrooms: 1 },
  { code: "STU00015", units: 12, beds: 3, bedrooms: 3, bathrooms: 1 },
  //  Real numbers: the ruling lifts 116 and 416 to 3BR-1.5BA BY NAME, because
  //  STU00017 is not a bath count. A synthetic number matches no override and
  //  the tool refuses — correctly. See skyline_unit_type_mapping.e2e.js.
  { code: "STU00017", units: 4,  beds: 3, bedrooms: 3, bathrooms: 1,
    numbers: ["1417-116", "1417-216", "1417-316", "1417-416"] },
];

(async () => {
  const tag = "PUB" + Math.floor(Math.random() * 1e6);
  console.log("\n── replica + governed unit types + governed authority ──");
  const prop = (await pool.query(
    `insert into properties (name, address, city, state, leasing_basis)
     values ($1,'1417 N 15th','Philadelphia','PA','bed') returning id`, [tag + " Skyline"])).rows[0].id;
  const batch = (await pool.query(
    `insert into import_batches (property_id, source_type, source_file, source_as_of_date, leasing_model, status)
     values ($1,'rent_roll_ledger','RentRoll07_1417.xlsx','2026-07-31','bed','committed') returning id`, [prop])).rows[0].id;
  let n = 0, ix = 0;
  for (const g of PLAN) for (let i = 0; i < g.units; i++) {
    n++;
    //  units.market_rent carries a SENTINEL. If a quoted number ever equals
    //  it, the legacy column reached the prospect path.
    const u = (await pool.query(
      `insert into units (property_id, unit_number, bedrooms, bathrooms, square_feet, market_rent)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [prop, g.numbers ? g.numbers[i] : `S-${1000 + n}`,
       g.bedrooms, g.bathrooms, 800, LEGACY_SENTINEL])).rows[0].id;
    await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u]);
    for (let b = 0; b < g.beds; b++) {
      const s = (await pool.query(
        `insert into spaces (unit_id, space_label) values ($1,$2) returning id`,
        [u, `Bed ${String.fromCharCode(65 + b)}`])).rows[0].id;
      await pool.query(
        `insert into import_source_rows (import_batch_id, row_index, raw, produced_unit_id, produced_space_id)
         values ($1,$2,$3,$4,$5)`,
        [batch, ix++, JSON.stringify({ unit_type: g.code,
          unit_number: g.numbers ? g.numbers[i] : `S-${1000 + n}`, status: "occupied" }), u, s]);
    }
  }
  execFileSync(process.execPath, [path.join(ROOT, "tools/apply_unit_type_mapping.js"), "--property", prop, "--apply"],
    { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { DATABASE_URL: process.env.E2E_DATABASE_URL }) });
  const types = (await pool.query(
    "select id, code, label from property_unit_types where property_id=$1 order by sort_order", [prop])).rows;
  types.length === 3 ? ok("3 governed unit types via the canonical tool") : bad("unit types missing", String(types.length));

  const admin = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'asset_manager',true,'active','human_staff') returning id`, [tag+" Admin", tag+"a@e.com"])).rows[0].id;
  const person = (await pool.query(
    "insert into persons (name,email,source) values ($1,$2,'staff_bridge') returning id", [tag+" KZ", tag+"kz@e.com"])).rows[0].id;
  const user = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'asset_manager',true,'active','human_staff',$3) returning id`, [tag+" KZ Login", tag+"kz@e.com", person])).rows[0].id;
  const reviewer = await establishAuthorizedReviewer(pool, {
    userId: admin, propertyId: prop, label: tag + " Authority Reviewer",
  });
  await pool.query(`insert into person_contexts (person_id,context_type,property_id,created_by_user_id)
                    values ($1,'staff',$2,$3)`, [person, prop, admin]);
  await resolveAuthority(pool, { spec: { user_id:user, person_id:person, property_id:prop,
    requested_role:"asset_manager", reviewer_user_id:admin, reason:"publication proof" }, apply:true });
  const auth = await pricingAuthority(pool, { property_id: prop, user_id: user });
  auth.may_publish_pricing ? ok("authority true", auth.basis.may_publish_pricing) : bad("no authority");

  //  ⚠ PLACEHOLDERS. Not Skyline's rents.
  const proposal = {
    publisher_person_id: person,
    effective_from: "2026-09-01",
    terms: types.map((t, i) => ({
      unit_type_id: t.id, lease_term_months: 12,
      base_rent: 1000 + i * 100, renewal_rent: 1050 + i * 100, offer_state: "offered",
    })),
  };

  console.log("\n── 1 · the contract, asked before a review exists ──");
  const pv = await previewPublication(pool, { property_id: prop, proposal });
  console.log(`     would_publish=${pv.would_publish}  blockers: ${(pv.blockers||[]).map(b=>b.code).join(", ")||"(none)"}`);
  //  no_reviewed_receipt is CORRECT here and is the only thing outstanding.
  //  Asserting would_publish at this point would be asserting that review is
  //  optional, which is the opposite of what this workflow is for.
  const onlyReceipt = (pv.blockers||[]).length === 1 && (pv.blockers||[])[0].code === "no_reviewed_receipt";
  onlyReceipt ? ok("everything satisfied except the human review", "no_reviewed_receipt")
              : bad("unexpected blockers before review", (pv.blockers||[]).map(b=>b.code).join(", "));

  console.log("\n── 2 · HOSTILE · a DECLARED legacy promotion is refused ──");
  //  market_rent_promotion fires on a declared provenance marker, not on
  //  value equality — the contract cannot infer where a number came from,
  //  so it requires the caller to say. Proving it means declaring it.
  const badProposal = { ...proposal, terms: proposal.terms.map((t) => ({ ...t, promoted_from: "units.market_rent" })) };
  const pvBad = await previewPublication(pool, { property_id: prop, proposal: badProposal });
  (pvBad.blockers||[]).some((b) => b.code === "market_rent_promotion")
    ? ok("market_rent_promotion refused", "the legacy column cannot become published pricing")
    : bad("a declared legacy promotion was accepted", (pvBad.blockers||[]).map(b=>b.code).join(","));

  console.log("\n── 3 · draft → review → publish, through the real lifecycle ──");
  let draft = null, receipt = null, published = null;
  try {
    draft = await saveDraft(pool, { property_id: prop, user_id: user, proposal });
    ok("draft saved", draft.draft_version_id || draft.version_id || JSON.stringify(draft).slice(0,60));
  } catch (e) { bad("saveDraft refused", e.message.slice(0,160)); }
  const draftId = draft && (draft.draft_version_id || draft.version_id || draft.id);
  try {
    //  The reviewer must hold governed authority too. Per the ruling
    //  recorded 2026-08-20 — one authorized asset manager is sufficient —
    //  the same person reviews and publishes, which publishVersion permits
    //  only because the basis is `assignment:`, not a grant.
    receipt = await submitReview(pool, { property_id: prop, user_id: user,
      draft_version_id: draftId, proposal, decision: "approved", note: "publication proof" });
    ok("review approved", (receipt && (receipt.review_receipt_id || receipt.id)) || JSON.stringify(receipt).slice(0,60));
  } catch (e) { bad("submitReview refused", e.message.slice(0,160)); }
  const receiptId = receipt && (receipt.review_receipt_id || receipt.id);
  try {
    //  receipt_reviewed is a PROPOSAL FLAG the preview takes on trust; the
    //  real gate is inside publishVersion, which re-reads the receipt, checks
    //  the decision is `approved`, and compares proposalDigest so an edited
    //  sheet cannot publish wearing an old approval. It is not in the digest,
    //  so setting it here does not invalidate the review.
    const reviewedProposal = { ...proposal, receipt_reviewed: true };
    published = await publishVersion(pool, { property_id: prop, user_id: user,
      draft_version_id: draftId, proposal: reviewedProposal, review_receipt_id: receiptId, dry_run: false });
    ok("PUBLISHED through the governed workflow", JSON.stringify(published).slice(0, 90));
  } catch (e) { bad("publishVersion refused", e.message.slice(0,200)); }

  const pvAfter = await previewPublication(pool, { property_id: prop,
    proposal: { ...proposal, receipt_reviewed: true } }).catch(() => null);
  if (pvAfter) console.log(`     contract after review: would_publish=${pvAfter.would_publish}`);

  const pubRow = (await pool.query(
    `select v.id, v.status, count(t.id)::int terms from property_pricing_versions v
       left join pricing_terms t on t.pricing_version_id=v.id
      where v.property_id=$1 and v.status='published' group by v.id, v.status`, [prop])).rows[0];
  pubRow ? ok("a published version exists", `${pubRow.terms} terms`) : bad("no published version");

  console.log("\n── 4 · the prospect-facing resolver now resolves — from the GOVERNED source ──");
  const space = (await pool.query(
    `select s.id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 limit 1`, [prop])).rows[0];
  //  BEFORE it takes effect: a published version is not yet an effective
  //  one, and quoting it early would be quoting a decision that has not
  //  started. The refusal here is correct behaviour, not a gap.
  const before = await resolveSpaceEconomics(pool, { property_id: prop, space_id: space.id,
    lease_term_months: 12, as_of: "2026-08-20" });
  before.resolved === false && before.reason === "no_published_pricing_version"
    ? ok("before effective_from it correctly refuses", "published ≠ effective")
    : bad("quoted a version that has not taken effect", JSON.stringify(before).slice(0, 140));

  const econ = await resolveSpaceEconomics(pool, { property_id: prop, space_id: space.id,
    lease_term_months: 12, as_of: "2026-09-01" });
  econ.resolved ? ok("on the effective date it resolves", `rent=${econ.rent}`)
                : bad("still refuses on the effective date", `${econ.reason} — ${econ.detail}`);
  if (econ.resolved) {
    //  ⚠ `rent` IS AN OBJECT, not a number. The first version of this check
    //  compared it to LEGACY_SENTINEL and passed — vacuously, because an
    //  object never equals a number. A green that cannot fail proves
    //  nothing, and the whole point of this assertion is the audit's §3.3
    //  finding, so it has to read the actual value.
    const quoted = econ.rent && econ.rent.new_lease_rent;
    typeof quoted === "number" && Number.isFinite(quoted)
      ? ok("a real number was quoted", `new_lease_rent=${quoted}`)
      : bad("rent did not carry a numeric new_lease_rent", JSON.stringify(econ.rent));

    quoted !== LEGACY_SENTINEL
      ? ok("the quoted rent is NOT the legacy market_rent", `${quoted} ≠ ${LEGACY_SENTINEL}`)
      : bad("THE LEGACY COLUMN REACHED THE PROSPECT PATH", `new_lease_rent=${quoted}`);

    const term = (await pool.query(
      `select pt.base_rent from pricing_terms pt where pt.id = $1`,
      [econ.authority && econ.authority.pricing_term_id])).rows[0];
    term && Number(quoted) === Number(term.base_rent)
      ? ok("the quoted rent IS the governed published term it cites",
           `${quoted} = pricing_terms.base_rent of ${String(econ.authority.pricing_term_id).slice(0,8)}`)
      : bad("the quoted rent does not match the term it names",
            `quoted=${quoted} term=${term && term.base_rent}`);

    econ.authority && econ.authority.published_version_id
      ? ok("the number states what authorised it", `version ${String(econ.authority.published_version_id).slice(0,8)} · ${econ.authority.basis}`)
      : bad("no authority basis on the quoted number");
  }

  //  CLEANUP — retire first, and do not swallow.
  //
  //  These three deletes used to be .catch(()=>{}) and the first one was
  //  FAILING on every run: trg_pricing_terms_frozen refuses to delete the
  //  terms of a published version, and CI's Postgres log recorded the raise
  //  on 2026-08-20 while this proof reported a clean 14/14. The suite then
  //  cleaned up anyway — but only through a hole. property_pricing_versions
  //  cascades to pricing_terms, and a cascade gets past the frozen trigger
  //  because it removes the version row before the terms trigger reads its
  //  status. So the teardown was quietly depending on a defect in the very
  //  rule the file above proves.
  //
  //  Retiring is the one transition the immutability rule permits, and it is
  //  what actually makes these deletes legal. With that line present the
  //  catches are not needed, so they are gone: a cleanup that hides its own
  //  failure is how this stayed invisible.
  await pool.query(
    "update property_pricing_versions set status='retired' where property_id=$1 and status='published'",
    [prop]);
  await pool.query("delete from pricing_terms where property_id=$1", [prop]);
  await pool.query("delete from property_pricing_versions where property_id=$1", [prop]);
  await pool.query("delete from pricing_review_receipts where property_id=$1", [prop]);
  await pool.query("delete from assignments where property_id=$1", [prop]);
  await pool.query("delete from person_contexts where property_id=$1", [prop]);
  await pool.query("delete from import_source_rows where import_batch_id=$1", [batch]);
  await pool.query("delete from import_batches where id=$1", [batch]);
  await pool.query("update units set unit_type_id=null where property_id=$1", [prop]);
  await pool.query("delete from property_unit_types where property_id=$1", [prop]);
  await pool.query("delete from spaces where unit_id in (select id from units where property_id=$1)", [prop]);
  await pool.query("delete from units where property_id=$1", [prop]);
  await pool.query("delete from users where id=any($1)", [[user, admin]]);
  await pool.query("delete from persons where id=any($1)", [[person, reviewer.personId]]);
  await pool.query("delete from properties where id=$1", [prop]);

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  publication: ${pass} passed · ${fail} failed`);
  if (firstRed) console.log(`  FIRST OBSERVED RED: ${firstRed}`);
  console.log(`══════════════════════════════════════════════════════════════`);
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
