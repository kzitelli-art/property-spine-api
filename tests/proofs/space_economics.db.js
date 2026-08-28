/* ════════════════════════════════════════════════════════════════════
   space_economics.db.js — THE AUTHORIZED ASKING ECONOMICS FOR ONE BED.
   REAL POSTGRES.

   Migration 182 made an application carry an exact bed. This proves the
   question that follows it: given THAT bed, what may Spine ask for it?

   ── WHAT IT PROVES, AND WHY EACH ONE MATTERS ────────────────────────
   · a type default applies to every bed of its type — which is how
     Skyline actually prices, so it must be the ordinary answer;
   · a SPACE OVERRIDE wins for its own bed and moves no sibling, so a
     legitimate within-unit price difference survives instead of being
     flattened to a single unit price;
   · absent pricing is NOT_ESTABLISHED and never the bed next door. This
     is the rule the build was told twice: do not guess a bed price from
     a sibling bed;
   · a term is CHOSEN, never defaulted to 12. Twelve is the commonest
     lease, which is exactly why quietly assuming it would quote a term
     nobody published;
   · a published `not_offered` is an ANSWER, not an absence;
   · an inventory-cohort override is refused rather than skipped —
     skipping it would answer with the type default while a narrower
     authorised row existed.

   ── AND THREE GOVERNANCE FACTS THE FIXTURE HAD TO OBEY ──────────────
   Found by writing it, not by reading about it:
     · a published version's terms are IMMUTABLE (102), so a bed override
       is a NEW VERSION, never an edit;
     · one published version per property at a time (uq_ppv_one_published),
       so repricing retires its predecessor;
     · before migration 183 a space override could not be inserted at all —
       101's unique index did not include the override columns, so the row
       collided with its own type default. 183 is that correction.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   Requires migrations 100, 101, 102 and 183.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/spine_proof \
       node tests/proofs/space_economics.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const { resolveSpaceEconomics } = require("../../src/money/effective_pricing.js");

const pool = new Pool({ connectionString: CONN });
let pass = 0, fail = 0; const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
};

(async () => {
  const q = (s,p) => pool.query(s,p);
  // ── a Skyline-shaped world: one 3-bed unit, three beds, one governed type
  const prop = (await q("insert into properties (name) values ('Skyline Proof') returning id")).rows[0].id;
  const type = (await q("insert into property_unit_types (property_id, code, label) values ($1,'3BR','3 Bed / 3 Bath') returning id",[prop])).rows[0].id;
  const unit = (await q("insert into units (property_id, unit_number, unit_type_id) values ($1,'3B',$2) returning id",[prop,type])).rows[0].id;
  // ensure_unit_space auto-created bed A; add B and C
  const bedA = (await q("select id from spaces where unit_id=$1",[unit])).rows[0].id;
  const bedB = (await q("insert into spaces (unit_id, space_label) values ($1,'Bed B') returning id",[unit])).rows[0].id;
  const bedC = (await q("insert into spaces (unit_id, space_label) values ($1,'Bed C') returning id",[unit])).rows[0].id;
  await q("update spaces set use_type='residential' where unit_id=$1",[unit]);

  console.log("\n── 1 · NO PUBLISHED VERSION → honest refusal, never a number ──");
  let r = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedB, lease_term_months:12});
  ok("unresolved", r.resolved===false);
  ok("…named as no published version", r.reason==="no_published_pricing_version", r.reason);
  ok("…and rent is null, not zero", r.rent===null);

  // publish a version with a 12-month type default of $1000
  // AUTHOR AS DRAFT, THEN PUBLISH — 102 makes a published version's terms
  // immutable, which is why a bed override is a NEW VERSION, never an edit.
  const ver = (await q(`insert into property_pricing_versions (property_id,status,effective_from,authority_basis)
    values ($1,'draft',current_date - 1,'{"basis":"proof"}'::jsonb) returning id`,[prop])).rows[0].id;
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state)
    values ($1,$2,$3,'3BR',12,1000,'offered')`,[ver,prop,type]);
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state, override_scope, override_ref)
    values ($1,$2,$3,'3BR',12,1225,'offered','space',$4)`,[ver,prop,type,bedB]);
  await q("update property_pricing_versions set status='published', published_at=now() where id=$1",[ver]);

  console.log("\n── 2 · TYPE DEFAULT applies to every bed of the type ──────────");
  for (const [n,b] of [["A",bedA],["C",bedC]]) {   // B carries an override; proven in §3
    const x = await resolveSpaceEconomics(pool,{property_id:prop, space_id:b, lease_term_months:12});
    ok(`bed ${n} resolves to the type default 1000`, x.resolved===true && x.rent.new_lease_rent===1000, JSON.stringify(x).slice(0,150));
    ok(`…basis says unit_type_default, not a borrowed price`, x.authority.basis==="unit_type_default");
  }

  console.log("\n── 3 · A SPACE OVERRIDE WINS, AND ONLY FOR ITS OWN BED ────────");
  const b = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedB, lease_term_months:12});
  ok("bed B takes its override (1225)", b.resolved===true && b.rent.new_lease_rent===1225, JSON.stringify(b.rent));
  ok("…basis says space_override", b.authority.basis==="space_override");
  const a = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedA, lease_term_months:12});
  ok("bed A is UNAFFECTED — within-unit difference preserved", a.rent.new_lease_rent===1000 && a.authority.basis==="unit_type_default");

  console.log("\n── 4 · A TERM IS CHOSEN, NEVER DEFAULTED TO 12 ────────────────");
  const noTerm = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedB});
  ok("no term → refusal, not a 12-month quote", noTerm.resolved===false && noTerm.reason==="lease_term_not_selected");
  ok("…and it names the published menu", Array.isArray(noTerm.published_terms) && noTerm.published_terms.includes(12));
  const badTerm = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedB, lease_term_months:9});
  ok("unpublished term → refusal naming what IS published", badTerm.resolved===false && badTerm.reason==="lease_term_not_published");

  console.log("\n── 5 · PUBLISHED NON-OFFER IS AN ANSWER, NOT AN ABSENCE ───────");
  //  A published version cannot be edited (102), so the non-offer is a NEW
  //  published version — which is exactly how a real repricing happens.
  await q("update property_pricing_versions set status='retired', effective_until=current_date - 1 where id=$1",[ver]);
  const ver2 = (await q(`insert into property_pricing_versions (property_id,status,effective_from,authority_basis)
    values ($1,'draft',current_date,'{"basis":"proof2"}'::jsonb) returning id`,[prop])).rows[0].id;
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state)
    values ($1,$2,$3,'3BR',12,1000,'not_offered')`,[ver2,prop,type]);
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state, override_scope, override_ref)
    values ($1,$2,$3,'3BR',12,1225,'offered','space',$4)`,[ver2,prop,type,bedB]);
  await q("update property_pricing_versions set status='published', published_at=now() where id=$1",[ver2]);
  const na = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedA, lease_term_months:12});
  ok("bed A now reports not_offered", na.resolved===false && na.reason==="not_offered", na.reason);
  ok("…and still no rent leaks out", na.rent===null);
  const stillB = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedB, lease_term_months:12});
  ok("bed B's own override still resolves", stillB.resolved===true && stillB.rent.new_lease_rent===1225);

  console.log("\n── 6 · CROSS-PROPERTY AND UNCLASSIFIED ────────────────────────");
  const other = (await q("insert into properties (name) values ('Other') returning id")).rows[0].id;
  const x1 = await resolveSpaceEconomics(pool,{property_id:other, space_id:bedB, lease_term_months:12});
  ok("a bed at another property refuses", x1.resolved===false && x1.reason==="space_not_at_property");
  const u2 = (await q("insert into units (property_id, unit_number) values ($1,'99') returning id",[prop])).rows[0].id;
  const s2 = (await q("select id from spaces where unit_id=$1",[u2])).rows[0].id;
  const x2 = await resolveSpaceEconomics(pool,{property_id:prop, space_id:s2, lease_term_months:12});
  ok("an unclassified position refuses, never inherits the only type", x2.resolved===false && x2.reason==="unit_type_not_established", x2.reason);

  console.log("\n── 7 · A COHORT OVERRIDE IS NOT SILENTLY SKIPPED ──────────────");
  await q("update property_pricing_versions set status='retired', effective_until=current_date - 1 where id=$1",[ver2]);
  const ver3 = (await q(`insert into property_pricing_versions (property_id,status,effective_from,authority_basis)
    values ($1,'draft',current_date,'{"basis":"proof3"}'::jsonb) returning id`,[prop])).rows[0].id;
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state)
    values ($1,$2,$3,'3BR',12,1000,'offered')`,[ver3,prop,type]);
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state, override_scope, override_ref)
    values ($1,$2,$3,'3BR',12,900,'offered','inventory_cohort',$4)`,[ver3,prop,type,unit]);
  await q("update property_pricing_versions set status='published', published_at=now() where id=$1",[ver3]);
  const co = await resolveSpaceEconomics(pool,{property_id:prop, space_id:bedC, lease_term_months:12});
  ok("cohort override present → refuses rather than quoting the default",
     co.resolved===false && co.reason==="inventory_cohort_override_not_resolvable", co.reason);


  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) failures.forEach((f) => console.log("   \u2717 " + f));
  console.log("════════════════════════════════════════════════════════════════");
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("DIED:", e && e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
