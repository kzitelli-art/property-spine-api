// ════════════════════════════════════════════════════════════════════
//  governed_charges.js — READ + PUBLICATION CONTRACT FOR THE CATALOG
//
//  The catalog holds one_time_fee, recurring_charge and deposit_required.
//  base_rent stays in pricing_terms and deposit_held stays on the lease, so a
//  charge row can never become a second asking rent or a fabricated liability.
//
//  READ-ONLY except publishCharge, which requires a resolved actor holding
//  may_publish_pricing. Nothing here activates a charge automatically.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { requireResolvedActor } = require("../identity/privileged_actor_contract");

const CLASSES = ["one_time_fee", "recurring_charge", "deposit_required"];
const OBLIGATIONS = ["required", "conditional", "optional"];
const EVENTS = ["application", "move_in", "renewal", "transfer", "lease_signing", "incidental"];

const blocker = (code, detail) => ({ code, detail });

/**
 * The publication contract for ONE charge. Pure — no database.
 * Fails closed: publication requires an empty blocker list.
 */
function checkChargePublishable(c = {}, ctx = {}) {
  const b = [];

  if (!CLASSES.includes(c.economic_class))
    b.push(blocker("invalid_economic_class", `economic_class must be one of ${CLASSES.join(", ")}.`));
  if (!OBLIGATIONS.includes(c.obligation))
    b.push(blocker("invalid_obligation", `obligation must be one of ${OBLIGATIONS.join(", ")}.`));

  // ── the collapses, refused by name ──────────────────────────────
  if (c.economic_class === "recurring_charge" && c.cadence !== "monthly")
    b.push(blocker("recurring_charge_not_monthly",
      "A recurring charge that does not recur monthly has no defined shape. Stored otherwise, " +
      "$X per month becomes $X once."));
  if (c.economic_class === "one_time_fee" && c.cadence === "monthly")
    b.push(blocker("one_time_fee_with_monthly_cadence",
      "A one-time fee billed monthly is a recurring charge. This is the $300 pet fee shape."));
  if (c.economic_class === "deposit_required" && c.refundable !== true)
    b.push(blocker("deposit_required_not_refundable",
      "A deposit requirement is refundable. Marking it otherwise recognises a refundable balance as income."));
  if (c.economic_class === "deposit_required" && c.counts_as_revenue === true)
    b.push(blocker("deposit_required_as_revenue", "A contractual requirement is not revenue."));
  if (c.economic_class === "one_time_fee" && c.refundable === true)
    b.push(blocker("refundable_fee", "A refundable charge is a deposit, not a fee."));
  if (c.economic_class === "base_rent" || c.economic_class === "deposit_held")
    b.push(blocker("class_not_in_catalog",
      "base_rent belongs to pricing_terms and deposit_held belongs to the lease. Neither may hold a catalog row."));

  // ── an amount is a number OR an explained absence ────────────────
  const hasAmount = c.amount != null;
  if (hasAmount && c.amount_unresolved_reason)
    b.push(blocker("amount_and_unresolved_reason", "A charge cannot be both resolved and unresolved."));
  if (!hasAmount && !c.amount_unresolved_reason)
    b.push(blocker("amount_missing", "State an amount, or state why it is unresolved."));
  if (!hasAmount && c.quotable_precisely === true)
    b.push(blocker("unresolved_marked_quotable",
      "A charge with no governed amount can never be quoted precisely."));
  if (c.amount_text && /(\d)\s*(–|—|-|to|or)\s*\$?\s*\d/.test(String(c.amount_text)) && hasAmount && !c.determinant)
    b.push(blocker("range_without_determinant",
      `"${c.amount_text}" admits more than one number and no determinant is declared, so ` +
      `$${c.amount} is a guess wearing the shape of a fact.`));

  // ── cadence, applicability, obligation ───────────────────────────
  if (!c.cadence) b.push(blocker("cadence_unknown", "Without cadence an amount cannot be summed or projected."));
  if (c.obligation === "required" && !c.applicability_basis)
    b.push(blocker("required_without_applicability",
      "'Required' with unknown scope reads as 'required of everyone' the moment anybody quotes it."));
  if (c.obligation === "conditional" && !c.condition_key)
    b.push(blocker("conditional_without_condition", "A conditional charge must name its condition."));
  if (c.obligation === "optional" && c.presented_as === "universal")
    b.push(blocker("optional_presented_as_universal",
      "An optional charge shown without its condition states an optional price as mandatory. " +
      "This is the renters-insurance shape: the coverage is required, the program price is not."));

  // ── event applicability for a one-time fee ───────────────────────
  if (c.economic_class === "one_time_fee") {
    if (!c.incurred_on_event || !EVENTS.includes(c.incurred_on_event))
      b.push(blocker("fee_without_event", `A one-time fee must say when it is incurred (${EVENTS.join(", ")}).`));
    const appliesNew = c.applies_to_new_lease !== false;
    if (!appliesNew && !c.applies_to_renewal && !c.applies_to_transfer)
      b.push(blocker("fee_applies_to_nothing", "A fee that applies to no event applies to nothing."));
  }
  if (c.waivable === true && !c.waiver_authority_verb)
    b.push(blocker("waivable_without_authority", "A waivable charge must say who may authorise the waiver."));

  // ── scope and identity ───────────────────────────────────────────
  if (!c.charge_code) b.push(blocker("no_charge_code", "A charge needs a stable code, not just a label."));
  if (!c.effective_from) b.push(blocker("no_effective_from", "A charge must state when it takes effect."));
  if (c.applicability_scope === "unit_type" && !c.unit_type_id)
    b.push(blocker("unit_type_scope_without_type", "A unit-type charge must name the governed type."));
  if (c.property_id && ctx.property_id && String(c.property_id) !== String(ctx.property_id))
    b.push(blocker("cross_property_charge", "A charge belongs to exactly one property."));

  // ── duplicate ownership of one quotable value ────────────────────
  if (ctx.existing_owners instanceof Map && c.charge_code && ctx.existing_owners.has(c.charge_code)) {
    const other = ctx.existing_owners.get(c.charge_code);
    if (other && other !== "governed_charge")
      b.push(blocker("duplicate_value_two_owners",
        `${c.charge_code} is already quotable from ${other}. Two independently quotable copies must ` +
        `never coexist — when one changes, the other silently disagrees.`));
  }

  // ── authority ────────────────────────────────────────────────────
  if (!ctx.actor_may_publish)
    b.push(blocker("no_publish_authority", "Publishing a governed charge requires may_publish_pricing."));

  return { publishable: b.length === 0, blockers: b };
}

/** Read the governed charge catalog for a property. READ-ONLY. */
async function governedCharges(pool, { property_id, as_of = null, include_drafts = false } = {}) {
  if (!property_id) throw new Error("governedCharges requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const rows = (await pool.query(
    `select c.*, put.label as unit_type_label, p.name as published_by
       from property_governed_charges c
       left join property_unit_types put on put.id = c.unit_type_id
       left join persons p on p.id = c.published_by_person_id
      where c.property_id = $1
        and ($2::boolean or c.record_state = 'active')
      order by c.economic_class, c.charge_code`, [property_id, include_drafts])).rows;

  // Postgres date columns arrive as Date objects, and String(Date) is
  // "Wed Jan 01 2026 …" — slicing that gives "Wed Jan 01", which compares
  // lexically ABOVE any ISO date and made every charge look not-yet-effective.
  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10));
  const effective = (c) =>
    c.record_state === "active"
    && ymd(c.effective_from) <= asOf
    && (!c.effective_until || ymd(c.effective_until) >= asOf);

  const shape = (c) => ({
    charge_id: c.id,
    charge_code: c.charge_code,
    display_label: c.display_label,
    economic_class: c.economic_class,
    amount: c.amount == null ? null : Number(c.amount),
    amount_unresolved_reason: c.amount_unresolved_reason,
    cadence: c.cadence,
    obligation: c.obligation,
    applicability_basis: c.applicability_basis,
    applicability_scope: c.applicability_scope,
    unit_type: c.unit_type_label || null,
    condition_key: c.condition_key,
    incurred_on_event: c.incurred_on_event,
    applies_to: [c.applies_to_new_lease ? "new_lease" : null,
                 c.applies_to_renewal ? "renewal" : null,
                 c.applies_to_transfer ? "transfer" : null].filter(Boolean),
    refundable: c.refundable,
    waivable: c.waivable,
    waiver_authority_verb: c.waiver_authority_verb,
    effective_from: ymd(c.effective_from),
    effective_until: c.effective_until ? ymd(c.effective_until) : null,
    record_state: c.record_state,
    effective_now: effective(c),
    source_provenance: c.source_provenance,
    authority_basis: c.authority_basis,
    published_by: c.published_by,
    published_at: c.published_at,
    // The single question every consumer asks.
    quotable_precisely: effective(c) && c.amount != null,
    not_quotable_reason: !effective(c)
      ? (c.record_state === "draft" ? "draft_has_no_operating_effect" : "not_effective_on_this_date")
      : c.amount == null ? c.amount_unresolved_reason : null,
  });

  const all = rows.map(shape);
  const byClass = (k) => all.filter((c) => c.economic_class === k);
  return {
    property_id, as_of: asOf,
    one_time_fees: byClass("one_time_fee"),
    recurring_charges: byClass("recurring_charge"),
    deposit_requirements: byClass("deposit_required"),
    summary: {
      total: all.length,
      active: all.filter((c) => c.record_state === "active").length,
      draft: all.filter((c) => c.record_state === "draft").length,
      quotable: all.filter((c) => c.quotable_precisely).length,
      unresolved: all.filter((c) => c.amount == null).length,
    },
    excluded_by_design: {
      base_rent: "lives in pricing_terms — a catalog row would create a second asking rent",
      deposit_held: "lives on the lease — a catalog row would let a requirement masquerade as a liability",
    },
  };
}

/** Publish one charge. Requires a resolved actor holding may_publish_pricing. */
async function publishCharge(pool, { property_id, charge, actor } = {}) {
  const a = requireResolvedActor(actor, "may_publish_pricing");
  if (a.kind !== "human") {
    const e = new Error("a human publishes charges — a system actor cannot");
    e.httpStatus = 400; e.publicMessage = e.message; throw e;
  }
  if (String(a.property_id) !== String(property_id)) {
    const e = new Error("actor was resolved for a different property");
    e.httpStatus = 403; e.publicMessage = e.message; throw e;
  }
  const check = checkChargePublishable({ ...charge, property_id },
    { property_id, actor_may_publish: true });
  if (!check.publishable) {
    const e = new Error("charge refused: " + check.blockers.map((x) => x.code).join(", "));
    e.httpStatus = 409; e.publicMessage = e.message; e.blockers = check.blockers; throw e;
  }
  const r = (await pool.query(
    `insert into property_governed_charges
       (property_id, charge_code, display_label, economic_class, cadence, amount,
        amount_unresolved_reason, obligation, applicability_basis, applicability_scope,
        unit_type_id, condition_key, incurred_on_event, applies_to_new_lease,
        applies_to_renewal, applies_to_transfer, refundable, waivable, waiver_authority_verb,
        effective_from, effective_until, record_state, source_provenance, authority_basis,
        published_by_person_id, published_at, publication_receipt)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             'active',$22,$23,$24,now(),$25) returning id`,
    [property_id, charge.charge_code, charge.display_label, charge.economic_class, charge.cadence,
     charge.amount ?? null, charge.amount_unresolved_reason ?? null, charge.obligation,
     charge.applicability_basis ?? null, charge.applicability_scope || "property",
     charge.unit_type_id ?? null, charge.condition_key ?? null, charge.incurred_on_event ?? null,
     charge.applies_to_new_lease !== false, !!charge.applies_to_renewal, !!charge.applies_to_transfer,
     charge.refundable ?? null, !!charge.waivable, charge.waiver_authority_verb ?? null,
     charge.effective_from, charge.effective_until ?? null, charge.source_provenance || "operator_entry",
     JSON.stringify({ verb: "may_publish_pricing", basis: a.authority_basis }), a.acting_person_id,
     JSON.stringify({ session_user_id: a.session_user_id, acting_person_id: a.acting_person_id,
                      authority_basis: a.authority_basis })])).rows[0];
  return { charge_id: r.id, record_state: "active",
           actor: { session_user_id: a.session_user_id, acting_person_id: a.acting_person_id,
                    authority_basis: a.authority_basis } };
}

module.exports = { governedCharges, publishCharge, checkChargePublishable, CLASSES, OBLIGATIONS, EVENTS };
