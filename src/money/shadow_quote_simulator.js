// ════════════════════════════════════════════════════════════════════
//  shadow_quote_simulator.js — WHAT WOULD CHANGE, BEFORE ANYONE HEARS IT
//
//  Compares what the CURRENT live pricing path would say against what a
//  proposed governed picture would say, for the same question.
//
//  ── IT CANNOT SEND ───────────────────────────────────────────────────
//  It never touches the SMS provider, never writes a comm_event, never
//  mutates a conversation, and never creates a person or a lead. It reads,
//  compares and returns. This matters more than usual here: the live path it
//  is modelling is the one that has been texting real phones.
//
//  ── WHY THIS EXISTS ──────────────────────────────────────────────────
//  Unit 530 was quoted $1,687 to nine real phones because availableUnits()
//  ordered by market_rent ascending and a single anomalous row sorted first.
//  Nothing compared that number to anything before it was said. This is that
//  comparison, run before a cutover rather than discovered after one.
//
//  The live side is modelled from units.market_rent and the approved fact
//  set — the same two sources agent.js actually reads. It is a MODEL of the
//  live path, not the live path itself, and it says so on every row, because
//  claiming to have executed the live agent would overstate the proof.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { effectivePropertyPricing } = require("./effective_pricing");
const { moneyFactContradictions } = require("./money_fact_contradictions");
const { quotablePricing } = require("../agent/pricing_adapter");

const SCENARIOS = [
  { key: "each_governed_type", note: "Every governed residential unit type, new lease and renewal." },
  { key: "unclassified_position", note: "Unit 101 — no governed unit type." },
  { key: "commercial_space", note: "Non-residential inventory carrying a legacy $0." },
  { key: "missing_pricing", note: "A type addressed as pricing_unavailable." },
  { key: "fee_questions", note: "The contradicted fee and recurring-charge facts." },
  { key: "advertised_concession", note: "A concession the proposed sheet advertises." },
  { key: "discretionary_concession", note: "A concession nobody has authority to offer." },
];

/**
 * Model what the CURRENT live path would answer for a unit type. Reads the
 * same two sources agent.js reads today: units.market_rent (ordered ascending,
 * which is what surfaced unit 530) and the approved fact set.
 */
async function liveAnswerForType(pool, property_id, unitTypeId) {
  const rows = (await pool.query(
    `select u.unit_number, u.market_rent
       from units u join spaces s on s.unit_id = u.id
      where u.property_id=$1 and u.unit_type_id is not distinct from $2
        and coalesce(u.is_down,false)=false
        and coalesce(u.operating_use,'standard')='standard'
        and s.use_type='residential'
        and u.bedrooms is not null
      order by u.market_rent asc nulls last`, [property_id, unitTypeId])).rows;
  if (!rows.length) {
    return { answer: null, source: "units.market_rent", would_say: "No availability to quote.", basis: "no_rows" };
  }
  const first = rows[0];
  return {
    answer: first.market_rent == null ? null : Number(first.market_rent),
    source: "units.market_rent",
    ordering: "market_rent asc nulls last — the ordering that surfaced unit 530 first",
    representative_unit: first.unit_number,
    candidates: rows.length,
    spread: rows.length > 1 ? Number(rows[rows.length - 1].market_rent) - Number(first.market_rent) : 0,
    would_say: first.market_rent == null
      ? "No price on file."
      : `Unit ${first.unit_number} is available at $${Number(first.market_rent).toLocaleString()} per month.`,
    basis: "legacy_column_unproven",
  };
}

/**
 * @param proposed_picture  an effectivePropertyPricing-shaped object to test
 *                          against, or null to test the CURRENT governed state.
 */
async function shadowQuoteReport(pool, { property_id, proposed_picture = null } = {}) {
  if (!property_id) throw new Error("shadowQuoteReport requires property_id");

  const governed = proposed_picture || await effectivePropertyPricing(pool, { property_id });
  const money = await moneyFactContradictions(pool, { property_id });

  // The adapter is called with a preloaded picture, so no query is needed and
  // a shim pool proves the simulator does not reach the database through it.
  const noPool = { query: async () => { throw new Error("shadow simulator must not query through the adapter"); } };

  const comparisons = [];
  for (const t of governed.unit_types) {
    const live = await liveAnswerForType(pool, property_id, t.unit_type_id);
    for (const intent of ["new_lease", "renewal"]) {
      const g = await quotablePricing(noPool, { property_id, unit_type_id: t.unit_type_id, intent },
        { picture: governed });

      const liveAmt = live.answer;
      const govAmt = g.quotable ? Number(g.rent) : null;
      const bothNumeric = liveAmt != null && govAmt != null;

      comparisons.push({
        scenario: t.code === "comm" ? "commercial_space" : "each_governed_type",
        unit_type: t.label, unit_type_id: t.unit_type_id, intent,

        live_answer: liveAmt,
        live_source: live.source,
        live_would_say: live.would_say,

        governed_answer: govAmt,
        governed_source: g.quotable ? "published_pricing_version" : null,
        governed_would_say: g.quotable
          ? `${t.label}, ${g.lease_term_months}-month term: $${govAmt.toLocaleString()} per month.`
          : g.say,
        governed_refusal: g.quotable ? null : g.reason,

        dollar_difference: bothNumeric ? Math.round((govAmt - liveAmt) * 100) / 100 : null,
        // The two paths disagreeing about WHETHER to answer is at least as
        // important as disagreeing about the number.
        refusal_difference: (liveAmt != null) !== (govAmt != null)
          ? (govAmt == null ? "live_answers_governed_refuses" : "live_refuses_governed_answers")
          : null,
        becomes_unavailable_after_cutover: liveAmt != null && govAmt == null,

        // The unit-530 shape: a live answer drawn from a spread with no stated
        // reason is unsupported precision whether or not it is "correct".
        unsupported_precision: live.spread > 0 ? {
          kind: "single_row_from_an_unexplained_spread",
          spread: live.spread, candidates: live.candidates,
          detail: `The live answer is one unit out of ${live.candidates} spanning $${live.spread}, ` +
                  `chosen by sort order rather than by a pricing decision.`,
        } : null,
      });
    }
  }

  // Unclassified position — the unit 101 case.
  const unclassified = (await pool.query(
    `select s.id space_id, u.unit_number from spaces s join units u on u.id=s.unit_id
      where u.property_id=$1 and u.unit_type_id is null limit 1`, [property_id])).rows[0] || null;
  if (unclassified) {
    const g = await quotablePricing(pool, { property_id, space_id: unclassified.space_id }, { picture: governed });
    comparisons.push({
      scenario: "unclassified_position",
      unit_type: `unit ${unclassified.unit_number} (no governed type)`, intent: "new_lease",
      live_answer: null, live_source: "units.market_rent",
      live_would_say: "The live path would quote this unit's own market_rent row if it were offerable.",
      governed_answer: null, governed_would_say: g.say, governed_refusal: g.reason,
      dollar_difference: null, refusal_difference: null,
      becomes_unavailable_after_cutover: false, unsupported_precision: null,
    });
  }

  // Fee and recurring-charge questions.
  const feeRows = money.facts.map((f) => ({
    scenario: "fee_questions", fact_key: f.fact_key,
    live_answer: f.amount, live_source: "agent_facts",
    live_would_say: f.text,
    governed_answer: null,
    governed_would_say: f.economic_class === "recurring_charge"
      ? "Recurring charges are governed outside this version and are not yet available for precise quoting."
      : "Fee amounts come from the approved property fact set during transition.",
    governed_refusal: f.verdict === "consistent_and_governed" ? null : f.verdict,
    unsupported_precision: f.unresolved ? { kind: "unresolved_value_stated_precisely", detail: f.unresolved } : null,
    becomes_unavailable_after_cutover: f.economic_class === "recurring_charge" || f.verdict === "not_safe_to_quote",
  }));

  // Concessions — advertised and prohibited-discretionary.
  const concessionRows = [
    {
      scenario: "advertised_concession",
      live_answer: null, live_source: "agent_facts (move_in_credits prose)",
      live_would_say: "Move-in credits: $500 for first responders, $500 for active military and veterans…",
      governed_answer: null,
      governed_would_say: (governed.concessions.advertised || []).length
        ? `${governed.concessions.advertised.length} advertised concession(s).`
        : "No concession is advertised.",
      governed_refusal: governed.concessions.concessions_unavailable || null,
      becomes_unavailable_after_cutover: true,
      unsupported_precision: {
        kind: "unauthorised_economic_promise",
        detail: "A dollar credit is being offered today from prose, with no version, no date and no " +
                "authority behind it. The governed path refuses it until the schedule engine can " +
                "place its dated lines.",
      },
    },
    {
      scenario: "discretionary_concession",
      live_answer: null, live_source: "none",
      live_would_say: "The live agent is instructed not to offer discretion, but nothing structurally stops a draft.",
      governed_answer: null, governed_would_say: "No discretionary concession may be offered.",
      governed_refusal: "no_concession_authority_grant_exists",
      becomes_unavailable_after_cutover: false,
      unsupported_precision: null,
    },
  ];

  const all = [...comparisons, ...feeRows, ...concessionRows];
  return {
    property_id,
    mode: "shadow",
    sent_anything: false,
    guarantees: [
      "no outbound SMS", "no comm_event written", "no conversation mutated",
      "no person or lead created", "no pricing row written",
    ],
    live_path_note:
      "The live side is MODELLED from the two sources agent.js reads (units.market_rent ordered " +
      "ascending, and the approved fact set). It is not an execution of the live agent, and no " +
      "row here should be read as one.",
    scenarios: SCENARIOS,
    comparisons: all,
    summary: {
      compared: all.length,
      dollar_disagreements: all.filter((c) => c.dollar_difference != null && c.dollar_difference !== 0).length,
      refusal_disagreements: all.filter((c) => c.refusal_difference).length,
      would_become_unavailable: all.filter((c) => c.becomes_unavailable_after_cutover).length,
      unsupported_precision: all.filter((c) => c.unsupported_precision).length,
      largest_dollar_gap: all.reduce((m, c) =>
        c.dollar_difference != null && Math.abs(c.dollar_difference) > Math.abs(m) ? c.dollar_difference : m, 0),
    },
  };
}

module.exports = { shadowQuoteReport, liveAnswerForType, SCENARIOS };
