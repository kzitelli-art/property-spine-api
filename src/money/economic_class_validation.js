// ════════════════════════════════════════════════════════════════════
//  economic_class_validation.js — THE CONTRACT, MADE EXECUTABLE
//
//  economic_classes.js says WHY the seven classes must stay distinct. This
//  file refuses the entries that would collapse them. Pure, no database.
//
//  Every rule here exists because a specific wrong number was reachable
//  without it. The rules are not stylistic; each names the number it stops.
//
//  IT DOES NOT BUILD THE RECURRING-CHARGE MODEL. A recurring charge entered
//  into a pricing sheet is REFUSED with a named reason, and the sheet is
//  allowed to say so out loud:
//      "Recurring charges are governed outside this version and are not yet
//       available for precise quoting."
//  That sentence is honest. Flattening parking, pet rent, wifi or insurance
//  into generic fee prose is not, because it would silently convert $30 a
//  month into $30 once — and nothing downstream could tell.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { ECONOMIC_CLASSES, CADENCE } = require("./economic_classes");

const CLASS_NAMES = Object.keys(ECONOMIC_CLASSES);
const MONTHLY_WORDS = /(per|a|each|\/)\s*month|monthly|\/mo\b|p\/m\b/i;
const ONE_TIME_WORDS = /one[-\s]?time|once|at move[-\s]?in|per application|upfront/i;
// A range is any statement that admits more than one number.
const RANGE_SHAPE = /\$?\s*[\d,]+(\.\d+)?\s*(–|—|-|to|through|up to|or)\s*\$?\s*[\d,]+/i;
const OPEN_RANGE = /\bup to\b|\bfrom\b\s*\$|\bstarting at\b|\bas low as\b|\bat least\b/i;

const err = (code, field, detail) => ({ code, field, detail });

/**
 * Validate ONE money entry against the class contract.
 * @param e {
 *   economic_class, amount, amount_text?, cadence, applicability,
 *   required, refundable, effective_from, authority, canonical_owner,
 *   advertised?, determinant?
 * }
 * @param ctx { existing_owners?: Map<string,string>, authority?: {...} }
 */
function validateMoneyEntry(e = {}, ctx = {}) {
  const errors = [];
  const c = e.economic_class;

  if (!c || !CLASS_NAMES.includes(c)) {
    errors.push(err("unknown_economic_class", "economic_class",
      `economic_class must be one of ${CLASS_NAMES.join(", ")}. It is never inferred from wording.`));
    return { valid: false, errors };   // nothing else can be judged without it
  }

  const text = String(e.amount_text || "");
  const looksMonthly = MONTHLY_WORDS.test(text);
  const looksOneTime = ONE_TIME_WORDS.test(text);

  // ── 1. a recurring monthly charge entered as a one-time fee ───────
  if (c === "one_time_fee" && looksMonthly) {
    errors.push(err("recurring_entered_as_one_time_fee", "economic_class",
      `"${text}" describes a monthly obligation but is classed one_time_fee. Stored that way, ` +
      `$X per month becomes $X once, and nothing downstream can tell the difference.`));
  }
  if (c === "recurring_charge" && looksOneTime && !looksMonthly) {
    errors.push(err("one_time_entered_as_recurring", "economic_class",
      `"${text}" describes a one-time charge but is classed recurring_charge, which would bill it every month.`));
  }

  // ── 2. a deposit-held claim entered as a lease requirement ────────
  if (c === "deposit_held" && e.required === true && e.amount_received !== true) {
    errors.push(err("requirement_entered_as_held_deposit", "economic_class",
      "deposit_held is money actually received. Recording a REQUIREMENT there states a liability " +
      "we may never have collected. Use deposit_required."));
  }
  if (c === "deposit_required" && e.canonical_owner && /pricing/i.test(e.canonical_owner)) {
    errors.push(err("deposit_requirement_owned_by_pricing", "canonical_owner",
      "A deposit requirement is underwriting, not an offer. Pricing may display it, not own it."));
  }

  // ── 3. a credit advertised as a concession without authority ──────
  if (c === "credit" && e.advertised === true) {
    const auth = ctx.authority || {};
    if (!auth.may_publish_pricing) {
      errors.push(err("credit_advertised_without_authority", "advertised",
        "A credit is a posting, not an authority to reduce. Advertising one requires a governed " +
        "concession published by someone holding may_publish_pricing."));
    } else {
      errors.push(err("credit_advertised_as_concession", "economic_class",
        "Even with authority, a credit is the dated consequence of a concession — publish the " +
        "concession, do not advertise the posting."));
    }
  }

  // ── 4. a range entered as one precise quotable amount ─────────────
  const hasRange = RANGE_SHAPE.test(text) || OPEN_RANGE.test(text);
  if (hasRange && e.amount != null && !e.determinant) {
    errors.push(err("range_quoted_as_precise_amount", "amount",
      `"${text}" admits more than one number and no determinant is declared, so $${e.amount} is a ` +
      `guess wearing the shape of a fact. Name what decides the amount, or leave it unresolved.`));
  }
  if (hasRange && e.amount == null && !e.determinant && e.quotable_precisely === true) {
    errors.push(err("unresolved_range_marked_quotable", "quotable_precisely",
      "A range with no determinant cannot be quoted precisely."));
  }

  // ── 5. a fee without known cadence ───────────────────────────────
  if (!e.cadence || !CADENCE.includes(e.cadence)) {
    errors.push(err("cadence_unknown", "cadence",
      `cadence must be one of ${CADENCE.join(", ")}. Without it, an amount cannot be summed, ` +
      `projected, or compared.`));
  } else if (c === "recurring_charge" && e.cadence !== "monthly") {
    errors.push(err("recurring_charge_without_monthly_cadence", "cadence",
      "A recurring charge that does not recur monthly has no defined shape in this model."));
  } else if (c === "base_rent" && e.cadence !== "monthly") {
    errors.push(err("base_rent_not_monthly", "cadence", "base_rent is monthly by definition."));
  }

  // ── 6. a required charge without known applicability ─────────────
  if (e.required === true && !e.applicability) {
    errors.push(err("required_without_applicability", "applicability",
      "A charge stated as required must say who it applies to. 'Required' with unknown scope " +
      "becomes 'required of everyone' the moment anybody reads it."));
  }
  if (e.required == null) {
    errors.push(err("required_unknown", "required",
      "required must be true or false. Unknown becomes 'optional' to a prospect and 'mandatory' to accounting."));
  }

  // ── 7. an optional charge presented as universal ──────────────────
  if (e.required === false && e.presented_as === "universal") {
    errors.push(err("optional_presented_as_universal", "presented_as",
      "An optional charge shown without its condition states an optional price as mandatory. " +
      "This is the renters-insurance shape: the coverage is required, the $15 program is not."));
  }
  if (e.required === true && e.applies_only_if) {
    errors.push(err("required_with_a_condition", "required",
      `Stated required, but only applies if: ${e.applies_only_if}. That is conditional, not required.`));
  }

  // ── 8. a duplicated value with two competing owners ───────────────
  const owners = ctx.existing_owners instanceof Map ? ctx.existing_owners : null;
  if (owners && e.value_key && owners.has(e.value_key)) {
    const other = owners.get(e.value_key);
    if (other && other !== e.canonical_owner) {
      errors.push(err("duplicate_value_two_owners", "canonical_owner",
        `${e.value_key} is already owned by ${other}. Two independently quotable copies must never ` +
        `coexist — when one changes, the other silently disagrees.`));
    }
  }

  // ── 9. refundability must be stated where it changes the meaning ──
  if ((c === "deposit_held" || c === "deposit_required") && e.refundable !== true) {
    errors.push(err("deposit_not_marked_refundable", "refundable",
      "A deposit is refundable subject to disposition. Marking it otherwise recognises a " +
      "refundable balance as income."));
  }
  if (c === "one_time_fee" && e.refundable === true) {
    errors.push(err("fee_marked_refundable", "refundable",
      "A refundable charge is a deposit, not a fee."));
  }

  return { valid: errors.length === 0, errors, economic_class: c };
}

/**
 * Validate a whole proposed pricing sheet's money entries together, so
 * cross-entry problems (two owners for one value) are caught.
 */
function validateMoneySet(entries = [], ctx = {}) {
  const owners = new Map(ctx.existing_owners instanceof Map ? ctx.existing_owners : []);
  const results = [];
  for (const e of entries) {
    const r = validateMoneyEntry(e, { ...ctx, existing_owners: owners });
    results.push({ entry: e.value_key || e.economic_class, ...r });
    if (e.value_key && e.canonical_owner && !owners.has(e.value_key)) owners.set(e.value_key, e.canonical_owner);
  }
  const errors = results.flatMap((r) => r.errors);

  // Recurring charges are refused, and the refusal carries the sentence the
  // sheet is permitted to say instead.
  const recurring = entries.filter((e) => e.economic_class === "recurring_charge");
  const recurring_disposition = recurring.length ? {
    accepted: false,
    reason: "recurring_charge_model_not_built",
    permitted_statement:
      "Recurring charges are governed outside this version and are not yet available for precise quoting.",
    entries: recurring.map((e) => e.value_key || null),
  } : null;

  return {
    valid: errors.length === 0 && !recurring.length,
    results, errors,
    recurring_disposition,
  };
}

module.exports = { validateMoneyEntry, validateMoneySet, CLASS_NAMES };
