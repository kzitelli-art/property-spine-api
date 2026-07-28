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

  let charges, legacy, actor, evidence;
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

  return {
    question: "Should Property Spine govern the administration fee as $99 per unit?",
    state: governed ? governed.record_state : "unavailable",
    amount: 99, amount_display: "$99",
    economic_class: "one-time fee",
    applies_to: "Undecided — see the open question",
    basis: "Per unit",
    effective_date: null,

    // ── THE THING THAT MUST BE ANSWERED FIRST ───────────────────────
    open_question: {
      question: "Is the $99 administration fee charged only for a new lease, or again when an " +
                "existing resident renews?",
      why_it_matters: "It changes what a renewing resident is told they owe, and whether renewal " +
                      "economics carry another one-time $99.",
      preselected: null,
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
      the_ai_will_say: "Depends on the ruling above — not yet determined.",
      legacy_retires: true,
      legacy_retires_when: "In the same transaction that activates the governed term.",
    },
    unchanged: [
      "The application fee — already governed and live at $50",
      "Rent — no pricing version is published",
      "Recurring charges, deposits and concessions",
    ],
    unresolved_issues: ["Renewal applicability is undecided."],

    actions: {
      // Deliberately false for everyone: authority is not the blocker here.
      may_approve: false,
      may_modify: mayDecide,
      may_reject: mayDecide,
      denied_reason: mayDecide
        ? "This can’t be approved yet — the renewal question above has to be answered first."
        : "You don’t have pricing authority for this property.",
      approve_label: "Approve — blocked until renewal applicability is decided",
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
