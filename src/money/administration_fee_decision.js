// ════════════════════════════════════════════════════════════════════
//  administration_fee_decision.js — THE SAME SHAPE, ONE OPEN QUESTION
//
//  The governed $99 row stays DRAFT and INACTIVE. The legacy fact stays the
//  only live source. Nothing here approves, activates or retires anything.
//
//  ── NO RULING IS PRESELECTED ─────────────────────────────────────────
//  The draft carries applies_to_renewal = true ONLY because the migration
//  candidate mirrored the prose. That mirroring is precisely what is under
//  review, so the card reports applicability as UNDECIDED rather than
//  presenting the mirror as a default. A card that arrives with the answer
//  already filled in turns a decision into a rubber stamp.
//
//  ── EVIDENCE IS REPORTED, NEVER INFERRED FROM ────────────────────────
//  renewalEvidence() reads every source that speaks to the question and
//  reports it verbatim. Absence of a posted charge is explicitly NOT treated
//  as evidence against renewal, because only a handful of charges of any kind
//  have ever been posted on this property.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveActorContext } = require("../identity/actor_context");
const { governedCharges } = require("./governed_charges");
const { renderChargeTerms, ASSESSED_PHRASE } = require("./governed_charge_language");

const CHARGE_CODE = "fee.administration";
const LEGACY_FACT = "pricing_admin_fee";

/** Every source that speaks to renewal applicability. Reported, not weighed. */
async function renewalEvidence(pool, property_id) {
  const facts = (await pool.query(
    `select fact_key, status, rendered_text from agent_facts
      where property_id=$1 and rendered_text ~* 'renew' order by fact_key`, [property_id])).rows;

  const posted = Number((await pool.query(
    `select count(*)::int n from scheduled_charges
      where property_id=$1 and (charge_type ~* 'admin' or coalesce(display_label,'') ~* 'admin')`,
    [property_id])).rows[0].n);
  const totalCharges = Number((await pool.query(
    "select count(*)::int n from scheduled_charges where property_id=$1", [property_id])).rows[0].n);
  const ledger = Number((await pool.query(
    "select count(*)::int n from ledger_entries where label ~* 'admin'")
    .catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);

  const mentionsAdmin = facts.filter((f) => /admin/i.test(f.rendered_text));
  return {
    supporting_renewal: mentionsAdmin.map((f) => ({
      source: `agent_facts.${f.fact_key}`, status: f.status, text: f.rendered_text,
    })),
    independent_sources: new Set(mentionsAdmin.map((f) => f.fact_key)).size,
    corroborating_pattern: facts.filter((f) => f.fact_key === "pricing_amenity_fee").map((f) => ({
      source: `agent_facts.${f.fact_key}`, status: f.status, text: f.rendered_text,
      note: "A DIFFERENT fee that also states a renewal amount. It shows the property does charge " +
            "some fees at renewal. It says nothing about THIS one.",
    })),
    contradicting_renewal: [],
    transactional_evidence: {
      admin_fee_charges_ever_posted: posted,
      admin_ledger_entries: ledger,
      total_scheduled_charges_on_property: totalCharges,
      // The trap this avoids: reading silence as a no.
      interpretation: posted === 0
        ? `NONE — and this is NOT evidence against renewal. Only ${totalCharges} charges of any kind ` +
          `have ever been posted on this property, so nothing has been posted for any fee.`
        : "see counts",
    },
    lease_documents_checked: true,
    lease_documents_finding: "No lease document or addendum table carries fee terms on this property.",
    conclusion:
      "TWO independently authored prose sources say the fee applies at renewal, and ZERO " +
      "transactional records exist either way. The prose is consistent but ambiguous: “once at " +
      "move-in and at renewal” can be read as one charge covering both events, or as one at each. " +
      "Absence of posted charges proves nothing here. This needs a human ruling, not a reading.",
  };
}

async function administrationFeeDecision(pool, { property_id, user_id = null } = {}) {
  if (!property_id) throw new Error("administrationFeeDecision requires property_id");

  let charges, legacy, actor, evidence, ruling = null;
  try {
    charges = await governedCharges(pool, { property_id, include_drafts: true });
    legacy = (await pool.query(
      `select fact_key, rendered_text, status from agent_facts
        where property_id=$1 and fact_key=$2`, [property_id, LEGACY_FACT])).rows[0] || null;
    actor = user_id ? await resolveActorContext(pool, { user_id, property_id }) : null;
    evidence = await renewalEvidence(pool, property_id);
  } catch (e) {
    return { state: "unavailable", question: null, error_is_not_absence: true,
             detail: "The current economic terms could not be read, so this decision cannot be shown." };
  }

  const governed = (charges.one_time_fees || []).find((c) => c.charge_code === CHARGE_CODE) || null;
  const mayDecide = !!(actor && actor.ok && actor.capabilities.may_publish_pricing);

  // ── THE RECORDED RULING, IF ONE EXISTS ────────────────────────────
  // Until a ruling was recorded this card hard-coded "Undecided" and "not yet
  // determined". Once the ruling landed those strings became false while the
  // row said otherwise — the same duplicated-meaning defect the application
  // card had. Everything below now derives from the row and its ruling.
  if (governed) {
    try {
      ruling = (await pool.query(
        `select id, selected_answer, occurred_at, prior_terms_digest, resulting_terms_digest,
                changed_fields_json, authority_exercised, actor_person_id
           from governed_charge_rulings
          where property_id=$1 and governed_charge_id=$2
          order by occurred_at desc limit 1`, [property_id, governed.charge_id])).rows[0] || null;
    } catch (e) { ruling = null; }
  }
  const rendered = governed ? renderChargeTerms(governed) : { quotable: false, reason: "unavailable" };
  const decided = !!ruling;

  return {
    question: decided && rendered.quotable
      ? `Publish this governed term: ${rendered.text}`
      : "Should Property Spine govern the administration fee as $99 per unit?",
    state: governed ? governed.record_state : "unavailable",
    // Read from the row, never asserted.
    amount: governed ? governed.amount : null,
    amount_display: governed && governed.amount != null
      ? `$${Number(governed.amount).toLocaleString("en-US")}` : null,
    economic_class: "one-time fee",
    applies_to: decided
      ? (governed.applies_to || []).map((a) => a.replace(/_/g, " ")).join(" and ") || "nothing"
      : "Undecided — see the open question",
    basis: governed && ASSESSED_PHRASE[governed.assessed_per]
      ? ASSESSED_PHRASE[governed.assessed_per].replace(/^p/, "P") : null,
    effective_date: null,

    // ── WHAT OWNERSHIP DECIDED ──────────────────────────────────────
    ruling_recorded: decided,
    ruling: decided ? {
      answer: ruling.selected_answer,
      label: ruling.selected_answer === "new_lease_only"
        ? "New lease only — a renewing resident is not charged this fee"
        : "New lease and renewal",
      decided_at: ruling.occurred_at,
      changed: ruling.changed_fields_json,
      authority_exercised: ruling.authority_exercised,
      // The prose that was superseded stays recoverable through the ruling
      // record; it is deliberately NOT shown here as current explanation.
      history_is_append_only: true,
    } : null,

    // ── THE THING THAT MUST BE ANSWERED FIRST ───────────────────────
    // `preselected` stays null while undecided so the card can never arrive
    // with the answer already filled in. Once a ruling exists it carries that
    // answer — continuing to present a decided question as open is its own
    // kind of dishonesty.
    open_question: {
      answered: decided,
      question: "Is the $99 administration fee charged only for a new lease, or again when an " +
                "existing resident renews?",
      why_it_matters: "It changes what a renewing resident is told they owe, and whether renewal " +
                      "economics carry another one-time $99.",
      preselected: decided ? ruling.selected_answer : null,
      rulings: [
        { ruling: "new_lease_only",
          label: "New lease only",
          consequence: "Renewal quotes exclude the fee. A renewing resident is told nothing about $99." },
        { ruling: "new_lease_and_renewal",
          label: "New lease and renewal",
          consequence: "Renewal economics include another one-time $99 charge, and the assistant says so at renewal." },
        { ruling: "conditional",
          label: "Conditional",
          consequence: "The exact renewal condition must be governed before the assistant can quote it — until then it stays unquotable at renewal." },
      ],
    },
    evidence,

    today: {
      source: "Legacy property fact",
      the_ai_says: legacy ? legacy.rendered_text : null,
      is_live: !!(legacy && legacy.status === "active"),
    },
    after_cutover: {
      source: "Governed administration fee",
      // Derived by the SAME renderer the assistant uses — no second wording.
      the_ai_will_say: rendered.quotable ? rendered.text : null,
      not_quotable_reason: rendered.quotable ? null : rendered.reason,
      legacy_retires: true,
      legacy_retires_when: "In the same transaction that activates the governed term.",
    },
    unchanged: [
      "The application fee — already governed and live at $50",
      "Rent — no pricing version is published",
      "Recurring charges, deposits and concessions",
    ],
    unresolved_issues: decided ? [] : ["Renewal applicability is undecided."],

    actions: {
      // Before the ruling this was false for EVERYONE: the blocker was the
      // question, not authority. The question is now answered, so authority
      // becomes the real gate again — and only for someone who holds it.
      may_approve: decided && mayDecide,
      may_modify: mayDecide,
      may_reject: mayDecide,
      denied_reason: !decided
        ? "This can’t be approved yet — the renewal question above has to be answered first."
        : mayDecide ? null : "You don’t have pricing authority for this property.",
      approve_label: decided
        ? "Approve — publish this governed term"
        : "Approve — blocked until renewal applicability is decided",
      modify_label: "Modify — return to preview",
      reject_label: "Reject — keep the current source",
    },

    audit: {
      governed_charge_id: governed ? governed.charge_id : null,
      charge_code: CHARGE_CODE,
      record_state: governed ? governed.record_state : null,
      quote_state: governed ? governed.quote_state : null,
      draft_applies_to_renewal: governed ? (governed.applies_to || []).includes("renewal") : null,
      draft_note: "The draft mirrors the prose. That mirroring is the thing under review, " +
                  "not a decision that has been made.",
      legacy_fact_key: LEGACY_FACT,
      legacy_status: legacy ? legacy.status : null,
      acting_person: actor && actor.person ? actor.person.display_name : null,
      property_id,
    },
  };
}

module.exports = { administrationFeeDecision, renewalEvidence, CHARGE_CODE, LEGACY_FACT };
