// ════════════════════════════════════════════════════════════════════
//  pricing_publication_preview.js — DRY RUN. WRITES NOTHING.
//
//  Accepts a PROPOSED initial pricing sheet and returns what would happen if
//  it were published. No insert, no update, no transaction — the pool is used
//  for reads only, and the response says so.
//
//  Two things make this worth building before the publish path rather than
//  after:
//
//   1. FAIL-CLOSED IS ONLY REAL IF IT CAN BE SEEN FIRST. A contract that only
//      refuses at the moment of writing teaches an operator to discover
//      blockers by trying to publish. This lets them see the refusal without
//      touching the database.
//
//   2. THE AI QUOTE PREVIEW IS THE ACTUAL DELIVERABLE. A pricing sheet is not
//      a table — it is what a real prospect will be told. So the preview runs
//      the REAL adapter against the proposed version and shows the sentence
//      each type would produce, including every type that would still hand
//      off. Reviewing the table is not the same as reviewing the speech.
//
//  It also refuses to preview a concession over a contradicted fee. The
//  permanent sequence is:
//        governed fee → governed waiver authority → offer → dated consequence
//  A fee waiver is the simplest timing shape, but waiving an ambiguous or
//  duplicated fee produces a discount whose size nobody can state.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { checkPublishable } = require("./pricing_publication_contract");
const { effectivePropertyPricing } = require("./effective_pricing");
const { moneyFactContradictions } = require("./money_fact_contradictions");
const { quotablePricing, HANDOFF } = require("../agent/pricing_adapter");

const BLOCKING_FEE_VERDICTS = new Set([
  "conflicting", "conditional_but_condition_missing", "prose_duplication", "not_safe_to_quote",
]);

/**
 * @param proposal {
 *   effective_from, effective_until?, publisher_person_id,
 *   terms: [{ unit_type_id, lease_term_months, base_rent, renewal_rent, offer_state }],
 *   concessions: [{ concession_type, timing_profile, fee_category, value, required_term_months }],
 *   receipt_reviewed?: boolean
 * }
 * @returns a full preview. `would_publish` is never true unless every blocker clears.
 */
async function previewPublication(pool, { property_id, proposal = {}, as_of = null } = {}) {
  if (!property_id) throw new Error("previewPublication requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const current = await effectivePropertyPricing(pool, { property_id, as_of: asOf });
  const money = await moneyFactContradictions(pool, { property_id });

  // ── publisher authority, read not asserted ────────────────────────
  // The caller supplies a person id; whether that person may publish is
  // decided here from assignments, never taken from the request body. That is
  // the same defect shape as caller-asserted actors on the ledger routes.
  // The predicate is the SAME one the ledger's publish path uses — an active
  // owner/asset-manager assignment, or an explicit publish grant. Reproducing
  // it with different rules would mean the preview could pass where the real
  // publish refuses, which is worse than having no preview.
  let publisher = { person_id: proposal.publisher_person_id || null, can_publish: false, name: null, basis: null };
  if (proposal.publisher_person_id) {
    const person = (await pool.query("select id, name from persons where id=$1",
      [proposal.publisher_person_id])).rows[0] || null;
    if (person) {
      const role = (await pool.query(
        `select role from assignments
          where property_id=$1 and person_id=$2 and is_active=true
            and role in ('owner','asset_manager') limit 1`, [property_id, person.id])).rows[0];
      const grant = role ? null : (await pool.query(
        `select id from concession_authority_grants
          where property_id=$1 and person_id=$2 and may_publish_public_offers=true
            and effective_from <= now()
            and (effective_until is null or effective_until > now()) limit 1`,
        [property_id, person.id])).rows[0];
      publisher = {
        person_id: person.id, name: person.name,
        can_publish: !!(role || grant),
        basis: role ? `assignment:${role.role}` : grant ? "explicit_publish_grant" : null,
      };
    }
  }

  // ── proposed terms, resolved against GOVERNED types ───────────────
  const typeById = new Map(current.unit_types.map((t) => [String(t.unit_type_id), t]));
  const terms = (proposal.terms || []).map((t) => {
    const gov = typeById.get(String(t.unit_type_id));
    return {
      ...t,
      property_id: gov ? property_id : null,   // unknown type -> no property, contract refuses
      label: gov ? gov.label : null,
      offer_state: t.offer_state || "offered",
      renewal_rent: Object.prototype.hasOwnProperty.call(t, "renewal_rent") ? t.renewal_rent : undefined,
    };
  });

  // A marketable type here EXCLUDES non-residential: commercial owes no
  // residential pricing decision and must not be demanded of a publisher.
  const marketable_types = current.unit_types
    .filter((t) => t.requires_pricing_decision)
    .map((t) => ({ unit_type_id: t.unit_type_id, label: t.label, marketable_positions: t.marketable_positions }));

  const existing_published = current.published_version ? [{
    version_id: current.published_version.version_id,
    effective_from: current.published_version.effective_from,
    effective_until: current.published_version.effective_until,
  }] : [];

  const contract = checkPublishable({
    property_id,
    effective_from: proposal.effective_from || null,
    effective_until: proposal.effective_until || null,
    publisher,
    existing_published,
    marketable_types,
    terms,
    concessions: proposal.concessions || [],
    fee_sources: { governed_count: 0, external_count: (current.fees.facts || []).length },
    receipt_reviewed: !!proposal.receipt_reviewed,
  });

  const blockers = [...contract.blockers];

  // ── fee contradictions block a concession over that fee ───────────
  const feeVerdict = new Map(money.facts.map((f) => [f.fact_key, f]));
  for (const c of proposal.concessions || []) {
    if (c.concession_type !== "fee_waiver") continue;
    const bad = money.facts.filter((f) =>
      f.economic_class === "one_time_fee" &&
      BLOCKING_FEE_VERDICTS.has(f.verdict) &&
      (!c.fee_category || String(f.fact_key).includes(String(c.fee_category))));
    if (bad.length) {
      blockers.push({
        code: "waiver_over_ungoverned_fee",
        detail: `A ${c.fee_category || "fee"} waiver cannot be previewed: ` +
          bad.map((b) => `${b.fact_key} is ${b.verdict}`).join("; ") +
          ". A waiver's size is the fee's amount, so an unresolved fee makes the discount unstatable.",
      });
    }
  }

  // ── unresolved fees are surfaced even with no concession ──────────
  const fee_contradictions = money.facts
    .filter((f) => BLOCKING_FEE_VERDICTS.has(f.verdict))
    .map((f) => ({ fact_key: f.fact_key, economic_class: f.economic_class, verdict: f.verdict, unresolved: f.unresolved || null }));

  const would_publish = blockers.length === 0;

  // ── THE AI QUOTE PREVIEW — the real deliverable ───────────────────
  // Built from the SAME adapter that would run live, against a simulated
  // published picture. If the sheet would not publish, every type still
  // hands off, and the preview says exactly that rather than showing the
  // prices the sheet WANTED to say.
  const simulated = would_publish
    ? {
        ...current,
        published_version: {
          version_id: "preview", status: "published",
          effective_from: proposal.effective_from, effective_until: proposal.effective_until || null,
          published_by: { person_id: publisher.person_id, name: publisher.name },
        },
        unit_types: current.unit_types.map((t) => {
          const rows = terms.filter((x) => String(x.unit_type_id) === String(t.unit_type_id));
          if (!rows.length) return t;
          const offered = rows.filter((r) => r.offer_state === "offered");
          return {
            ...t,
            offer_state: offered.length ? "offered" : rows[0].offer_state,
            terms: offered.map((r) => ({
              lease_term_months: r.lease_term_months,
              new_lease_rent: r.base_rent == null ? null : Number(r.base_rent),
              renewal_rent: r.renewal_rent == null ? null : Number(r.renewal_rent),
            })),
          };
        }),
      }
    : null;

  // A tiny shim pool: the adapter's only query resolves a space to a type,
  // and the preview always supplies the type directly, so it is never reached.
  const previewPool = { query: async () => { throw new Error("preview must not query"); } };
  const quote_preview = [];
  for (const t of current.unit_types) {
    for (const intent of ["new_lease", "renewal"]) {
      let q;
      if (!simulated) {
        q = HANDOFF("no_published_pricing_version",
          "The proposed sheet would not publish, so nothing would be quotable.");
      } else {
        // Real adapter, real refusal logic, simulated sheet.
        q = await quotablePricing(previewPool,
          { property_id, unit_type_id: t.unit_type_id, intent },
          { picture: simulated });
      }
      quote_preview.push({
        unit_type_id: t.unit_type_id, label: t.label, intent,
        quotable: q.quotable,
        rent: q.quotable ? q.rent : null,
        lease_term_months: q.quotable ? q.lease_term_months : null,
        would_say: q.quotable
          ? `${t.label}, ${q.lease_term_months}-month term: $${Number(q.rent).toLocaleString()} per month.`
          : q.say,
        reason: q.quotable ? null : q.reason,
      });
    }
  }

  const remains_unavailable = [
    { value: "concessions", reason: "schedule_line_engine_not_activated" },
    { value: "move_in_credits", reason: "calendar_dependent_concession_cannot_be_published" },
    { value: "recurring_charges", reason: "recurring_charge_model_not_built" },
    { value: "security_deposit", reason: "underwriting_requirement_not_modelled" },
    { value: "telecom_fee_exact_amount", reason: "range_determinant_not_declared" },
    { value: "market_evidence", reason: "governed_market_observations_not_built" },
  ];

  return {
    property_id, as_of: asOf,
    disposition: "dry_run_no_write_performed",

    would_publish,
    blockers,
    completeness_failures: blockers.filter((b) => b.code === "marketable_type_not_addressed"),
    missing_unit_types: marketable_types
      .filter((mt) => !terms.some((t) => String(t.unit_type_id) === String(mt.unit_type_id)))
      .map((mt) => ({ unit_type_id: mt.unit_type_id, label: mt.label, marketable_positions: mt.marketable_positions })),
    missing_rent_decisions: terms
      .filter((t) => t.offer_state === "offered" && (t.base_rent == null || t.renewal_rent === undefined))
      .map((t) => ({ unit_type_id: t.unit_type_id, label: t.label,
        missing: [t.base_rent == null ? "new_lease_rent" : null, t.renewal_rent === undefined ? "renewal_rent" : null].filter(Boolean) })),
    invalid_terms: blockers.filter((b) => b.code === "invalid_lease_term" || b.code === "invalid_offer_state"),
    fee_contradictions,
    unsupported_concessions: blockers.filter((b) =>
      b.code === "concession_timing_profile_not_implemented" || b.code === "waiver_over_ungoverned_fee"),
    effective_date_overlap: blockers.filter((b) =>
      b.code === "overlapping_published_version" || b.code === "effective_until_before_from" || b.code === "no_effective_from"),

    publisher_authority_required: {
      supplied_person_id: proposal.publisher_person_id || null,
      resolved_name: publisher.name,
      can_publish: publisher.can_publish,
      basis: publisher.basis,
      rule: "Publish authority is READ from an active owner/asset-manager assignment on this " +
            "property. It is never taken from the request body.",
    },

    receipt: {
      before: {
        published_version: current.published_version ? current.published_version.version_id : null,
        state: current.published_version ? "published" : "no_published_pricing_version",
        types_addressed: current.completeness.types_addressed,
        types_requiring_decision: current.completeness.types_requiring_decision,
      },
      after: {
        published_version: would_publish ? "(would be created)" : null,
        state: would_publish ? "published" : "unchanged — refused",
        types_addressed: would_publish ? marketable_types.length : current.completeness.types_addressed,
        types_requiring_decision: marketable_types.length,
        effective_from: proposal.effective_from || null,
        effective_until: proposal.effective_until || null,
      },
      ...contract.receipt,
    },

    quote_preview,
    remains_unavailable,
  };
}

module.exports = { previewPublication, BLOCKING_FEE_VERDICTS };
