// ════════════════════════════════════════════════════════════════════
//  governed_charge_language.js — ONE RENDERER, STRUCTURED FIELDS ONLY
//
//  THE DEFECT THIS CLOSES
//  ----------------------
//  A governed charge carried two independently maintained meanings: the
//  structured columns, and `applicability_basis` free text. The assistant
//  quoted the prose. Nothing that quotes ever read the booleans — so setting
//  applies_to_renewal = false would have left the assistant still saying
//  "and once at renewal", and the row would have looked correct while the
//  resident heard the opposite.
//
//  Structured fields are now the only source of resident-facing language.
//  `applicability_basis` survives as evidence and operator explanation. It is
//  carried on the payload as `supporting_explanation` and is NEVER read to
//  build the sentence — not as a fallback, not on contradiction, not when a
//  term is missing. A missing term produces an honest refusal instead.
//
//  WHY IT COULD NOT BE BUILT BEFORE MIGRATION 110
//  ----------------------------------------------
//  "Per applicant" and "per unit" existed only in the prose. Rendering from
//  structure alone silently dropped them — a confident sentence missing a
//  material term. 110 added `assessed_per`, so the structure is now complete
//  enough to speak from. A row without it is refused, not guessed.
//
//  THE INVARIANT
//  -------------
//  applies_to_renewal = false  =>  no quotable sentence can mention renewal.
//  Enforced twice: the renewal clause is unreachable when the boolean is
//  false, and a post-render guard re-checks the finished string. The guard
//  returns an unquotable result rather than throwing, because the assistant
//  must degrade to honest silence, never to an exception mid-conversation.
//
//  CLASSIFICATION: Class 1 permanent primitive. Pure — no I/O, no database,
//  no caching. The sentence is derived on every read and stored nowhere, so it
//  can never become a second source of truth.
// ════════════════════════════════════════════════════════════════════

"use strict";

/** assessed_per -> plain language. Schema words never reach a resident. */
const ASSESSED_PHRASE = { applicant: "per applicant", unit: "per unit" };

/** Words that may not appear when the matching boolean is false. */
const FORBIDDEN_WHEN_FALSE = {
  applies_to_renewal: /\brenew(al|s|ing)?\b/i,
  applies_to_transfer: /\btransfer(s|red|ring)?\b/i,
};

/** An event that asserts a lifecycle the booleans deny is a contradiction. */
const EVENT_IMPLIES = { renewal: "applies_to_renewal", transfer: "applies_to_transfer" };

/** Trailing "due …" clause, only where the event adds information. */
const EVENT_TAIL = {
  move_in: "due at move-in",
  lease_signing: "due at lease signing",
  // application / renewal / transfer are already carried by the lifecycle
  // clause — repeating them reads robotic. incidental has no fixed moment.
};

function money(amount, currency) {
  const n = Number(amount);
  const body = Number.isInteger(n) ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { minimumFractionDigits: 2 });
  return currency && currency !== "USD" ? `${body} ${currency}` : `$${body}`;
}

function joinClauses(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The lifecycle clause, built ONLY from the three booleans. The incurred event
 * sharpens the new-lease phrase where it genuinely narrows the meaning —
 * "for a new lease application" rather than "for a new lease" — which is how
 * the live $50 keeps its full meaning without listing fields mechanically.
 */
function lifecycleClause(c) {
  const parts = [];
  if (c.applies_to_new_lease) {
    parts.push(c.incurred_on_event === "application" ? "for a new lease application"
                                                     : "for a new lease");
  }
  if (c.applies_to_renewal) parts.push("at renewal");
  if (c.applies_to_transfer) parts.push("for a transfer");
  return parts.length ? joinClauses(parts) : null;
}

const unquotable = (reason, c) => ({
  quotable: false,
  reason,
  text: null,
  supporting_explanation: c && c.applicability_basis ? c.applicability_basis : null,
});

/**
 * Render the resident-facing sentence for one governed charge.
 *
 * @returns {{quotable:true, text:string, derived_from:object, ...}}
 *        | {{quotable:false, reason:string, text:null, ...}}
 */
function renderChargeTerms(c = {}) {
  const label = String(c.display_label || c.charge_code || "").trim();
  if (!label) return unquotable("no_display_label", c);

  // ── every term required to avoid a misleading sentence ────────────
  if (c.amount == null) return unquotable(c.amount_unresolved_reason ? "amount_unresolved"
                                                                    : "amount_missing", c);
  if (!c.cadence) return unquotable("cadence_unknown", c);
  if (!ASSESSED_PHRASE[c.assessed_per]) {
    return unquotable(c.assessed_per == null ? "assessment_basis_unresolved"
                                             : "assessment_basis_unknown_value", c);
  }
  if (c.obligation === "conditional" && !c.condition_key) {
    return unquotable("condition_unresolved", c);
  }

  // ── a row that disagrees with itself is not quotable ───────────────
  // e.g. incurred_on_event='renewal' while applies_to_renewal=false. We can
  // see the conflict but not which side is right, so we refuse rather than
  // pick one and sound certain.
  const denied = EVENT_IMPLIES[c.incurred_on_event];
  if (denied && !c[denied]) return unquotable("contradictory_terms", c);

  const lifecycle = lifecycleClause(c);
  if (!lifecycle) return unquotable("applies_to_nothing", c);

  // ── assemble ──────────────────────────────────────────────────────
  const bits = [`The ${label.toLowerCase()} is ${money(c.amount, c.currency)}`];
  if (c.cadence === "monthly") bits.push("per month");
  bits.push(ASSESSED_PHRASE[c.assessed_per]);
  bits.push(lifecycle);

  let text = bits.join(" ");
  if (c.obligation === "conditional") {
    text += `, when ${String(c.condition_key).replace(/_/g, " ")}`;
  }
  const tail = EVENT_TAIL[c.incurred_on_event];
  if (tail) text += `, ${tail}`;
  if (c.obligation === "optional") text += ", and it is optional";
  text += ".";

  // ── the guard: the finished string may not contradict the row ──────
  for (const [field, pattern] of Object.entries(FORBIDDEN_WHEN_FALSE)) {
    if (!c[field] && pattern.test(text)) return unquotable("render_contradicts_structure", c);
  }

  return {
    quotable: true,
    text,
    // The structured terms the sentence was built from, so a caller can show
    // its work without re-deriving it — and so the sentence never has to be
    // stored to be explained.
    derived_from: {
      display_label: label,
      amount: Number(c.amount), currency: c.currency || "USD",
      cadence: c.cadence, obligation: c.obligation, assessed_per: c.assessed_per,
      applies_to_new_lease: !!c.applies_to_new_lease,
      applies_to_renewal: !!c.applies_to_renewal,
      applies_to_transfer: !!c.applies_to_transfer,
      incurred_on_event: c.incurred_on_event || null,
      condition_key: c.condition_key || null,
    },
    // Carried for operators and audit. Never consulted above.
    supporting_explanation: c.applicability_basis || null,
    // Non-null when the evidence prose disagrees with the structure. Surfaced
    // for an operator to reconcile; it does NOT change the sentence.
    supporting_explanation_warning: basisWarning(c),
  };
}

/**
 * Does the evidence prose contradict the structured lifecycle? Reported, never
 * acted on — the sentence is already built from structure by this point.
 */
function basisWarning(c) {
  const prose = String(c.applicability_basis || "");
  if (!prose) return null;
  const claims = [];
  if (/\brenew/i.test(prose) && !c.applies_to_renewal) claims.push("renewal");
  if (/\btransfer/i.test(prose) && !c.applies_to_transfer) claims.push("transfer");
  if (!claims.length) return null;
  return `The saved explanation mentions ${claims.join(" and ")}, but the governed terms say this ` +
         `charge does not apply then. The governed terms decide what is quoted; ` +
         `the explanation needs correcting.`;
}

module.exports = { renderChargeTerms, lifecycleClause, ASSESSED_PHRASE };
