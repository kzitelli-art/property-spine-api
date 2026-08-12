/* ════════════════════════════════════════════════════════════════════
   tax_funding_read.js — HOW ARE THIS PROPERTY'S TAXES PAID FOR?

   Reports the funding arrangement, the escrow terms, what the last
   statement said the balance was, and what the servicer claims to have
   disbursed. It never totals any of it into a tax cost, because none of
   it is a tax cost.

   ── THE THREE THINGS THIS READ REFUSES TO SAY ───────────────────────
   1  It never reports a balance as a payment. A servicer holding
      $18,000 against a $14,203 bill has proved they hold the money.
      Whether they sent it is a different fact with different evidence.
   2  It never reports a contribution as an accrual. The monthly
      contribution is cash to a servicer; the accrual is the governed
      liability over the obligation's period, computed elsewhere in a
      module that cannot see this one.
   3  It never quietly resolves a disagreement. Where the escrow claims a
      disbursement and no City payment is evidenced, that gap is
      SURFACED — with both sides visible — rather than settled in favour
      of whichever is more convenient.

   ── THE GAP IS THE PRODUCT ──────────────────────────────────────────
   `unevidenced_disbursements` is the reason this read is worth having.
   It is the operator's version of the question nobody asks until March:
   the servicer says they paid it, the City has no record we can show,
   and somebody should find out which is true. Spine cannot resolve it,
   so it names it.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

//  The jurisdiction's list of taxes, not a second copy of it. Funding may
//  reference the economic side; only the reverse is the defect.
const rules = require("./philadelphia_tax_rules.js");

const METHOD_LABEL = Object.freeze({
  direct: "Paid directly",
  lender_escrow: "Paid from lender escrow",
});

const p2 = (n) => String(n).padStart(2, "0");

function isoDay(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (!(d instanceof Date)) return null;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function dayDiff(a, b) {
  const A = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), B = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!A || !B) return null;
  return Math.round((Date.UTC(+B[1], +B[2] - 1, +B[3]) - Date.UTC(+A[1], +A[2] - 1, +A[3]))
    / 86400000);
}
const num = (v) => (v === null || v === undefined ? null : Number(v));

/*  ── READ TAX FUNDING ───────────────────────────────────────────────
 *  Property-facing, the same compression the position read performs: an
 *  entity's BIRT funding surfaces on each related property and stays one
 *  arrangement with one id.
 */
async function readTaxFunding(client, { property_id, as_of = null } = {}) {
  const today = as_of || isoDay(new Date());

  const entities = (await client.query(
    `select distinct r.legal_entity_id as id
       from legal_entity_properties r
      where r.property_id = $1
        and r.effective_from <= $2
        and (r.effective_to is null or r.effective_to > $2)`,
    [property_id, today])).rows;
  const entityIds = entities.map((e) => e.id);

  //  Live arrangements only. Superseded ones are corrections and closed
  //  ones belong to a period that has passed; both stay readable through
  //  history, neither is how this tax is funded today.
  const { rows } = await client.query(
    `select a.*,
            e.lender_name, e.servicer_name, e.escrow_account_reference,
            e.monthly_contribution_cents
       from tax_funding_arrangements a
       left join tax_escrow_arrangements e on e.arrangement_id = a.id
      where (a.subject_property_id = $1 or a.subject_legal_entity_id = any($2::uuid[]))
        and a.effective_from <= $3
        and (a.effective_to is null or a.effective_to > $3)
        and not exists (select 1 from tax_funding_arrangements s
                         where s.supersedes_id = a.id)
      order by a.tax_type asc`,
    [property_id, entityIds, today]);

  const ids = rows.map((r) => r.id);

  /*  ── THE LATEST BALANCE, PER ESCROW — NOT PER SLICE ───────────────
   *  Keyed to (tax_type, subject), deliberately, NOT to the live
   *  arrangement id. A servicer's annual analysis raises the contribution
   *  and opens a new slice; the escrow ACCOUNT is the same account, and
   *  blanking its balance because a term changed would report a fact
   *  Spine holds as unknown — honest-blank inverted.
   *
   *  What travels with it is the account it was observed under, so a
   *  servicer change is visible instead of silently carrying one
   *  servicer's balance onto another's arrangement.
   */
  const subjectKeys = rows.map((r) =>
    String(r.subject_property_id || r.subject_legal_entity_id));
  const observations = rows.length ? (await client.query(
    `select distinct on (a.tax_type,
              coalesce(a.subject_property_id::text, a.subject_legal_entity_id::text))
            a.tax_type,
            coalesce(a.subject_property_id::text, a.subject_legal_entity_id::text)
              as subject_key,
            o.arrangement_id, o.observed_on, o.balance_cents, o.currency_code,
            o.source_artifact_id, o.provenance_note,
            e.escrow_account_reference as observed_account_reference
       from tax_escrow_observations o
       join tax_funding_arrangements a on a.id = o.arrangement_id
       left join tax_escrow_arrangements e on e.arrangement_id = a.id
      where coalesce(a.subject_property_id::text, a.subject_legal_entity_id::text)
              = any($1::text[])
      order by a.tax_type,
               coalesce(a.subject_property_id::text, a.subject_legal_entity_id::text),
               o.observed_on desc`, [subjectKeys])).rows : [];

  /*  ── DISBURSEMENTS, AND WHETHER THE CITY AGREES ───────────────────
   *  A SELECT against the economic side. The boundary permits funding to
   *  reference what it funds; what it forbids is funding AUTHORING it,
   *  and this read writes nothing.
   *
   *  `city_payment_count` is deliberately a count of evidence, not a
   *  boolean the read invents. Zero means nobody has recorded evidence
   *  the City was paid — which is not the same as "unpaid", and the
   *  wording downstream says so.
   */
  const disbursements = rows.length ? (await client.query(
    `select d.id, d.arrangement_id, d.obligation_id, d.disbursed_on,
            d.amount_cents, d.currency_code, d.reference,
            d.source_artifact_id, d.provenance_note,
            o.tax_type, o.period_start,
            coalesce(a.subject_property_id::text, a.subject_legal_entity_id::text)
              as subject_key,
            (select count(*)::int from tax_payments p
              where p.obligation_id = d.obligation_id) as city_payment_count
       from tax_escrow_disbursements d
       join tax_funding_arrangements a on a.id = d.arrangement_id
       join tax_obligations o on o.id = d.obligation_id
      where coalesce(a.subject_property_id::text, a.subject_legal_entity_id::text)
              = any($1::text[])
      order by d.disbursed_on desc`, [subjectKeys])).rows : [];

  const arrangements = rows.map((r) => {
    const key = String(r.subject_property_id || r.subject_legal_entity_id);
    const obs = observations.find(
      (o) => o.tax_type === r.tax_type && o.subject_key === key) || null;
    //  Disbursements travel with the escrow too, for the same reason: a
    //  disbursement made in March under last year's contribution is still
    //  what happened to this bill.
    const mine = disbursements.filter(
      (d) => d.subject_key === key && d.tax_type === r.tax_type);

    const out = {
      arrangement_id: r.id,
      tax_type: r.tax_type,
      subject_kind: r.subject_property_id ? "property" : "legal_entity",
      funding_method: r.funding_method,
      method_label: METHOD_LABEL[r.funding_method] || r.funding_method,
      effective_from: isoDay(r.effective_from),
      effective_to: isoDay(r.effective_to),
      provenance_strength: r.source_artifact_id ? "documentary" : "attested",
      provenance_note: r.provenance_note,
      corrected: !!r.supersedes_id,
      revision_reason: r.revision_reason,
      escrow: null,
      disbursements: mine.map((d) => ({
        disbursement_id: d.id,
        obligation_id: d.obligation_id,
        disbursed_on: isoDay(d.disbursed_on),
        amount_cents: num(d.amount_cents),
        currency_code: d.currency_code,
        reference: d.reference,
        //  ⚠ THE HEADLINE FIELD OF THIS WHOLE MODULE.
        //  The servicer's account of what they did, held apart from
        //  whether the City has been evidenced as paid.
        city_payment_evidenced: d.city_payment_count > 0,
      })),
    };

    if (r.funding_method === "lender_escrow") {
      out.escrow = {
        lender_name: r.lender_name || null,
        servicer_name: r.servicer_name || null,
        escrow_account_reference: r.escrow_account_reference || null,
        //  CASH TO A SERVICER. Named so it can never be mistaken for the
        //  monthly accrual, which lives in the economic read and is
        //  routinely a different number.
        monthly_contribution_cents: num(r.monthly_contribution_cents),
        balance: obs ? {
          balance_cents: num(obs.balance_cents),
          currency_code: obs.currency_code,
          observed_on: isoDay(obs.observed_on),
          //  A balance is true on its statement date and starts going
          //  stale immediately. The surface shows the age so a
          //  four-month-old figure is never read as today's.
          days_old: dayDiff(isoDay(obs.observed_on), today),
          provenance_strength: obs.source_artifact_id ? "documentary" : "attested",
          //  Observed under an EARLIER slice of the same escrow — after an
          //  analysis changed the contribution, say. The balance is still
          //  the account's; saying which arrangement saw it is what keeps
          //  a servicer change visible instead of implied.
          observed_under_current_arrangement: obs.arrangement_id === r.id,
          observed_account_reference: obs.observed_account_reference || null,
        } : null,
        //  Said in the payload, not only in a comment, because it is the
        //  rule a surface would otherwise have to remember.
        balance_is_not_payment:
          "An escrow balance shows what the servicer holds. It is not evidence the City " +
          "was paid.",
      };
    }
    return out;
  });

  //  ── WHERE THE TWO SIDES DISAGREE ─────────────────────────────────
  //  Surfaced, never resolved. Spine has one party's word and no
  //  confirmation from the other; that is the finding.
  const unevidenced = disbursements
    .filter((d) => d.city_payment_count === 0)
    .map((d) => ({
      disbursement_id: d.id,
      obligation_id: d.obligation_id,
      tax_type: d.tax_type,
      disbursed_on: isoDay(d.disbursed_on),
      amount_cents: num(d.amount_cents),
      why: "The servicer's statement shows a disbursement toward this bill. No City " +
           "payment evidence is on file, so Spine cannot report it as paid.",
      resolves: "Add the City receipt, confirmation or account statement showing the " +
                "payment posted.",
    }));

  return {
    as_of: today,
    established: arrangements.length > 0,
    arrangements,
    methods: Array.from(new Set(arrangements.map((a) => a.funding_method))),
    //  Which taxes have no funding answer at all. UNKNOWN stated as
    //  unknown — an absent arrangement is never reported as "paid
    //  directly", which would be a settled answer invented from silence.
    //  It is the whole reason this key exists rather than an empty list
    //  of arrangements being left to speak for itself.
    unknown_for: rules.requiredTaxTypes()
      .filter((t) => !arrangements.some((a) => a.tax_type === t))
      .map((t) => ({ tax_type: t, label: rules.TAX_LABEL[t] })),
    unevidenced_disbursements: unevidenced,
  };
}

module.exports = { readTaxFunding, METHOD_LABEL };
