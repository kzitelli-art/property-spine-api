/*  ════════════════════════════════════════════════════════════════════
    agent_pricing_wall.e2e.js — WHAT REACHES A PROSPECT WHO ASKS THE PRICE.

    The audit's highest-severity finding: the prospect-facing agent read
    units.market_rent — a legacy per-unit column with no publish step, no
    version and no review — and put it in the model's context. It had
    already been wrong in production: $237 off on unit 530, to nine phones.

    This proves the rewire from BOTH directions, because only proving one
    would be half a proof:

      · with NO published pricing the agent must quote NOTHING and hand off
      · with published pricing it must quote the GOVERNED number
      · in neither case may the legacy column appear anywhere

    THE SENTINEL. units.market_rent carries a value that could not plausibly
    arise any other way. If it turns up in what the model is handed, the
    legacy column is still reaching the prospect path whatever the code says.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { quotablePricing } = require(path.join(ROOT, "src/agent/pricing_adapter.js"));
const { resolveAuthority } = require(path.join(ROOT, "src/identity/authority_resolution.js"));
const { saveDraft, submitReview, publishVersion } = require(path.join(ROOT, "src/money/pricing_lifecycle.js"));
const { establishAuthorizedReviewer } = require(path.join(
  ROOT, "tests/support/authority_reviewer_fixture.js"));

const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
const SENTINEL = 424242;
let pass = 0, fail = 0;
const ok  = (l, d="") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d="") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };

(async () => {
  const tag = "AGP" + Math.floor(Math.random() * 1e6);

  console.log("\n── 0 · the source no longer names the legacy column ──");
  const src = require("fs").readFileSync(path.join(ROOT, "src/agent/agent.js"), "utf8");
  const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  !/market_rent/.test(stripped)
    ? ok("agent.js contains no live reference to market_rent", "comments excluded")
    : bad("market_rent still referenced in live code");
  /quotablePricing/.test(stripped)
    ? ok("agent.js reaches the governed adapter") : bad("adapter not wired");

  console.log("\n── setup: a property with the sentinel on every unit, no pricing ──");
  const prop = (await pool.query(
    `insert into properties (name,address,leasing_basis) values ($1,'1 Wall St','bed') returning id`,
    [tag + " Wall"])).rows[0].id;
  const ut = (await pool.query(
    `insert into property_unit_types (property_id, code, label, sort_order)
     values ($1,'2BR','2 Bedroom',10) returning id`, [prop])).rows[0].id;
  const unit = (await pool.query(
    `insert into units (property_id, unit_number, bedrooms, bathrooms, market_rent, unit_type_id)
     values ($1,'W-1',2,1,$2,$3) returning id`, [prop, SENTINEL, ut])).rows[0].id;
  //  A TYPE WITH NO RESIDENTIAL POSITION IS OUTSIDE RESIDENTIAL PRICING —
  //  effective_pricing counts `use_type = 'residential'`, and the trigger's
  //  placeholder carries a NULL use_type. Without this the adapter answers
  //  not_applicable_to_residential_pricing and the proof measures the wrong
  //  refusal: correct behaviour, wrong question.
  await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [unit]);
  await pool.query(
    `insert into spaces (unit_id, space_label, use_type, position_kind)
     values ($1,'Bed A','residential','bed')`, [unit]);

  console.log("\n── 1 · NO published pricing → the adapter refuses ──");
  const q1 = await quotablePricing(pool, { property_id: prop, unit_type_id: ut });
  q1.quotable === false
    ? ok("not quotable", q1.reason)
    : bad("quoted with no published version", JSON.stringify(q1).slice(0, 120));
  q1.say && /confirm the current pricing/.test(q1.say)
    ? ok("it supplies its own handoff sentence", q1.say.slice(0, 60) + "…")
    : bad("no handoff sentence");
  !JSON.stringify(q1).includes(String(SENTINEL))
    ? ok("the refusal carries no legacy number")
    : bad("THE SENTINEL IS IN THE REFUSAL", JSON.stringify(q1).slice(0, 160));

  console.log("\n── 2 · publish governed pricing through the real workflow ──");
  const admin = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'asset_manager',true,'active','human_staff') returning id`, [tag+"A", tag+"a@e.com"])).rows[0].id;
  const person = (await pool.query(
    "insert into persons (name,email,source) values ($1,$2,'staff_bridge') returning id", [tag+"P", tag+"p@e.com"])).rows[0].id;
  const user = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'asset_manager',true,'active','human_staff',$3) returning id`, [tag+"L", tag+"p@e.com", person])).rows[0].id;
  const reviewer = await establishAuthorizedReviewer(pool, {
    userId: admin, propertyId: prop, label: tag + " Authority Reviewer",
  });
  await pool.query(`insert into person_contexts (person_id,context_type,property_id,created_by_user_id)
                    values ($1,'staff',$2,$3)`, [person, prop, admin]);
  await resolveAuthority(pool, { spec: { user_id:user, person_id:person, property_id:prop,
    requested_role:"asset_manager", reviewer_user_id:admin, reason:"agent pricing wall proof" }, apply:true });

  const GOVERNED = 1234;   // deliberately unlike the sentinel
  const proposal = { publisher_person_id: person, effective_from: "2026-01-01",
    terms: [{ unit_type_id: ut, lease_term_months: 12, base_rent: GOVERNED,
              renewal_rent: GOVERNED, offer_state: "offered" }] };
  const d = await saveDraft(pool, { property_id: prop, user_id: user, proposal });
  const draftId = d.draft_version_id || d.version_id || d.id;
  const rec = await submitReview(pool, { property_id: prop, user_id: user,
    draft_version_id: draftId, proposal, decision: "approved", note: "proof" });
  await publishVersion(pool, { property_id: prop, user_id: user, draft_version_id: draftId,
    proposal: { ...proposal, receipt_reviewed: true },
    review_receipt_id: rec.review_receipt_id, dry_run: false });
  ok("governed pricing published", `${GOVERNED}/mo`);

  console.log("\n── 3 · WITH published pricing → the governed number, not the legacy one ──");
  const q2 = await quotablePricing(pool, { property_id: prop, unit_type_id: ut });
  q2.quotable ? ok("quotable now", `rent=${q2.rent}`) : bad("still refusing", q2.reason);
  if (q2.quotable) {
    Number(q2.rent) === GOVERNED
      ? ok("it quotes the GOVERNED rent", `${q2.rent}`)
      : bad("quoted something else", String(q2.rent));
    Number(q2.rent) !== SENTINEL
      ? ok("it is NOT the legacy market_rent", `${q2.rent} ≠ ${SENTINEL}`)
      : bad("THE LEGACY COLUMN REACHED THE QUOTE");
    q2.proof && q2.proof.basis === "published_pricing_version"
      ? ok("the number states its basis", q2.proof.basis)
      : bad("no proof of basis", JSON.stringify(q2.proof));
  }
  //  ── 4 · A TERM THAT WAS NOT PUBLISHED IS REFUSED, NOT SUBSTITUTED ──
  //  Skyline publishes ONE term (12 months) and treats 5- and 7-month leases
  //  as an upsell a person negotiates. That only holds if asking for an
  //  unpublished term produces a handoff rather than the published number
  //  quietly standing in for it — a prospect asking about a 5-month lease and
  //  hearing the 12-month rate has been misquoted just as surely as by a
  //  legacy column.
  console.log("\n── 4 · an UNPUBLISHED term is refused, not substituted ──");
  const q3 = await quotablePricing(pool, { property_id: prop, unit_type_id: ut, lease_term_months: 5 });
  q3.quotable === false
    ? ok("a 5-month term is not quotable", q3.reason)
    : bad("QUOTED AN UNPUBLISHED TERM", `${q3.rent} for ${q3.lease_term_months}mo`);
  q3.reason === "term_not_published"
    ? ok("and it names why", q3.reason)
    : bad("wrong refusal reason", String(q3.reason));
  !JSON.stringify(q3).includes(String(GOVERNED))
    ? ok("the published 12-month rent does not leak into the refusal")
    : bad("THE 12-MONTH RENT APPEARS IN A 5-MONTH REFUSAL");

  !JSON.stringify(q2).includes(String(SENTINEL))
    ? ok("the sentinel appears nowhere in the quote")
    : bad("THE SENTINEL IS IN THE QUOTE");

  //  ── 5 · WITH TWO TERMS PUBLISHED, IT OFFERS THE CHOICE ─────────────
  //  Defect #14. terms[0] is deterministically the SHORTEST term, which is
  //  the dearest, so an unqualified price question was answered with the
  //  highest number on the sheet. Publishing a second term is what makes it
  //  fire, so the test publishes one.
  console.log("\n── 5 · two published terms → the menu, not the dearest ──");
  //  A published version's terms are frozen, so a second term cannot be added
  //  to the one above — trg_pricing_terms_frozen refuses the INSERT, which is
  //  correct. Two terms therefore means a version published WITH two, on its
  //  own property, rather than a rule bent to make a test convenient.
  const SHORT_RENT = GOVERNED + 150;
  const prop2 = (await pool.query(
    `insert into properties (name,address,leasing_basis) values ($1,'2 Wall St','bed') returning id`,
    [tag + " Wall Two"])).rows[0].id;
  const ut2 = (await pool.query(
    `insert into property_unit_types (property_id, code, label, sort_order)
     values ($1,'2BR','2 Bedroom',10) returning id`, [prop2])).rows[0].id;
  const unit2 = (await pool.query(
    `insert into units (property_id, unit_number, bedrooms, bathrooms, market_rent, unit_type_id)
     values ($1,'W2-1',2,1,$2,$3) returning id`, [prop2, SENTINEL, ut2])).rows[0].id;
  await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [unit2]);
  await pool.query(`insert into spaces (unit_id, space_label, use_type, position_kind)
                    values ($1,'Bed A','residential','bed')`, [unit2]);
  await pool.query(`insert into person_contexts (person_id,context_type,property_id,created_by_user_id)
                    values ($1,'staff',$2,$3)`, [person, prop2, admin]);
  await establishAuthorizedReviewer(pool, { userId: admin, propertyId: prop2 });
  await resolveAuthority(pool, { spec: { user_id:user, person_id:person, property_id:prop2,
    requested_role:"asset_manager", reviewer_user_id:admin, reason:"multi-term proof" }, apply:true });

  const proposal2 = { publisher_person_id: person, effective_from: "2026-01-01",
    terms: [
      { unit_type_id: ut2, lease_term_months: 12, base_rent: GOVERNED,   renewal_rent: GOVERNED,   offer_state: "offered" },
      { unit_type_id: ut2, lease_term_months:  5, base_rent: SHORT_RENT, renewal_rent: SHORT_RENT, offer_state: "offered" },
    ] };
  const d2 = await saveDraft(pool, { property_id: prop2, user_id: user, proposal: proposal2 });
  const draftId2 = d2.draft_version_id || d2.version_id || d2.id;
  const rec2 = await submitReview(pool, { property_id: prop2, user_id: user,
    draft_version_id: draftId2, proposal: proposal2, decision: "approved", note: "multi-term proof" });
  await publishVersion(pool, { property_id: prop2, user_id: user, draft_version_id: draftId2,
    proposal: { ...proposal2, receipt_reviewed: true },
    review_receipt_id: rec2.review_receipt_id, dry_run: false });
  ok("a two-term version is published", `${GOVERNED} on 12mo, ${SHORT_RENT} on 5mo`);

  const q4 = await quotablePricing(pool, { property_id: prop2, unit_type_id: ut2 });
  q4.quotable === false
    ? ok("an unqualified question is no longer answered with a number", q4.reason)
    : bad("STILL GUESSES A TERM", `${q4.rent} for ${q4.lease_term_months}mo`);
  q4.reason === "lease_term_not_selected"
    ? ok("and agrees with effective_pricing's own reason", q4.reason)
    : bad("wrong reason", String(q4.reason));
  Number(q4.rent) !== SHORT_RENT && !JSON.stringify(q4).includes(`"rent":${SHORT_RENT}`)
    ? ok("the dearest term is NOT quoted", `$${SHORT_RENT} withheld`)
    : bad("QUOTED THE SHORTEST/DEAREST TERM ANYWAY");
  Array.isArray(q4.published_terms) && q4.published_terms.join(",") === "5,12"
    ? ok("it returns the menu", `[${q4.published_terms}]`)
    : bad("no menu", JSON.stringify(q4.published_terms));
  /which length are you looking for/.test(q4.say || "")
    ? ok("and asks the prospect to choose") : bad("no question to the prospect", String(q4.say).slice(0,90));

  //  naming a term still works, and each returns its OWN rent
  const q5 = await quotablePricing(pool, { property_id: prop2, unit_type_id: ut2, lease_term_months: 12 });
  const q6 = await quotablePricing(pool, { property_id: prop2, unit_type_id: ut2, lease_term_months: 5 });
  q5.quotable && Number(q5.rent) === GOVERNED
    ? ok("naming 12 months quotes the 12-month rent", `${q5.rent}`) : bad("12-month wrong", JSON.stringify(q5).slice(0,90));
  q6.quotable && Number(q6.rent) === SHORT_RENT
    ? ok("naming 5 months quotes the 5-month rent", `${q6.rent}`) : bad("5-month wrong", JSON.stringify(q6).slice(0,90));

  //  CLEANUP — unswallowed, and it obeys the rule it just proved.
  //
  //  A published version's terms are frozen by trg_pricing_terms_frozen, so
  //  this test cannot delete what it published while it is still published.
  //  That is not an obstacle to route around: there is deliberately NO
  //  governed operation that deletes a published version, because published
  //  pricing is a permanent record. The one transition the immutability rule
  //  DOES permit is published → retired, so the test ends its own version's
  //  life the way the system says a version's life ends, and only then
  //  removes the rows. Retiring first is the whole reason the deletes below
  //  are allowed to succeed; drop that line and this teardown correctly
  //  refuses again.
  //
  //  There is a second route that also works, and it is deliberately not
  //  used: `delete from properties` cascades to versions and then to terms,
  //  and the frozen trigger does NOT refuse it (observed 2026-08-20 — the
  //  cascade removes the version row before the terms trigger looks its
  //  status up, so the status reads NULL). That is a hole in the
  //  immutability rule, not a supported way to end a version. A teardown
  //  built on it would quietly break the day the hole is closed, and would
  //  teach the next reader that published pricing is deletable. It is not.
  //
  //  (Then dependency order: property_pricing_versions references the review
  //  receipt, so versions go before receipts. A cleanup that hides its own
  //  failure produced a confusing FK error three lines later instead of
  //  saying what went wrong — hence no .catch() anywhere in here.)
  for (const pid of [prop, prop2]) {
    await pool.query(
      "update property_pricing_versions set status='retired' where property_id=$1 and status='published'",
      [pid]);
    await pool.query("delete from pricing_terms where property_id=$1",[pid]);
    await pool.query("delete from property_pricing_versions where property_id=$1",[pid]);
    await pool.query("delete from pricing_review_receipts where property_id=$1",[pid]);
    await pool.query("delete from assignments where property_id=$1",[pid]);
    await pool.query("delete from person_contexts where property_id=$1",[pid]);
    await pool.query("delete from spaces where unit_id in (select id from units where property_id=$1)",[pid]);
    await pool.query("update units set unit_type_id=null where property_id=$1",[pid]);
    await pool.query("delete from units where property_id=$1",[pid]);
    await pool.query("delete from property_unit_types where property_id=$1",[pid]);
  }
  await pool.query("delete from pricing_terms where property_id=$1",[prop]);
  await pool.query("delete from property_pricing_versions where property_id=$1",[prop]);
  await pool.query("delete from pricing_review_receipts where property_id=$1",[prop]);
  await pool.query("delete from assignments where property_id=$1",[prop]);
  await pool.query("delete from person_contexts where person_id=$1",[person]);
  await pool.query("delete from spaces where unit_id=$1",[unit]);
  await pool.query("update units set unit_type_id=null where property_id=$1",[prop]);
  await pool.query("delete from units where property_id=$1",[prop]);
  await pool.query("delete from property_unit_types where property_id=$1",[prop]);
  await pool.query("delete from users where id=any($1)",[[user,admin]]);
  await pool.query("delete from persons where id=any($1)",[[person, reviewer.personId]]);
  await pool.query("delete from properties where id=any($1)",[[prop, prop2]]);

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  agent pricing wall: ${pass} passed · ${fail} failed`);
  console.log(`══════════════════════════════════════════════════════════════`);
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error("DIED:", e && e.stack ? e.stack : e); process.exit(1); });
