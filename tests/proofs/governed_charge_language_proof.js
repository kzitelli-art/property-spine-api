// ════════════════════════════════════════════════════════════════════
//  governed_charge_language_proof.js — STRUCTURE IS THE ONLY SOURCE
//
//  WHAT THIS PROTECTS
//  ------------------
//  A governed charge used to carry two independently maintained meanings: the
//  structured columns and `applicability_basis` free text. The assistant quoted
//  the prose, so a row could say applies_to_renewal = false while a resident
//  was told the fee applies at renewal. These assertions make that impossible
//  to reintroduce without turning this file red.
//
//  Pure: no database, no network, no writes.
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node tests/proofs/governed_charge_language_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const { renderChargeTerms } = require("../../src/money/governed_charge_language");

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push("  ok    " + label); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
const render = (patch) => renderChargeTerms({ ...BASE, ...patch });
const textOf = (patch) => { const r = render(patch); return r.quotable ? r.text : `(unquotable: ${r.reason})`; };

// The live $50, exactly as it sits in property_governed_charges today.
const BASE = {
  display_label: "Application fee", economic_class: "one_time_fee", cadence: "one_time",
  amount: 50, currency: "USD", obligation: "required", assessed_per: "applicant",
  applicability_basis: "Per applicant on a new-lease application.",
  applicability_scope: "property", incurred_on_event: "application",
  applies_to_new_lease: true, applies_to_renewal: false, applies_to_transfer: false,
};

const APPROVED = "The application fee is $50 per applicant for a new lease application.";

// ── THE APPROVED WORDING ─────────────────────────────────────────────
ok("the live $50 renders the APPROVED sentence, exactly", textOf({}) === APPROVED, textOf({}));
ok("it is quotable", render({}).quotable === true);

// ── ASSESSMENT BASIS ─────────────────────────────────────────────────
ok("assessed_per=applicant  -> 'per applicant'", /\bper applicant\b/.test(textOf({})));
ok("assessed_per=unit       -> 'per unit'",
  /\bper unit\b/.test(textOf({ assessed_per: "unit", display_label: "Administration fee" })));
ok("schema words never reach the sentence",
  !/assessed_per|applicant\b(?!s)\W*$|new_lease|incurred/.test(textOf({})));

// ── LIFECYCLE VOCABULARY ─────────────────────────────────────────────
const nl = { applies_to_new_lease: true, applies_to_renewal: false, applies_to_transfer: false };
ok("new lease only, non-application event -> 'for a new lease'",
  /for a new lease\./.test(textOf({ ...nl, incurred_on_event: null })), textOf({ ...nl, incurred_on_event: null }));
ok("new lease + application event -> 'for a new lease application'",
  /for a new lease application/.test(textOf({})));
ok("renewal only -> 'at renewal'",
  textOf({ applies_to_new_lease: false, applies_to_renewal: true, incurred_on_event: "renewal" })
    .includes("at renewal"));
ok("transfer only -> 'for a transfer'",
  textOf({ applies_to_new_lease: false, applies_to_transfer: true, incurred_on_event: "transfer" })
    .includes("for a transfer"));
ok("new lease AND renewal -> 'for a new lease application and at renewal'",
  textOf({ applies_to_renewal: true }).includes("and at renewal"), textOf({ applies_to_renewal: true }));
ok("all three lifecycles read as a list, not a pile",
  /for a new lease application, at renewal and for a transfer/.test(
    textOf({ applies_to_renewal: true, applies_to_transfer: true })),
  textOf({ applies_to_renewal: true, applies_to_transfer: true }));

// ── THE LOAD-BEARING INVARIANT ───────────────────────────────────────
ok("applies_to_renewal=false -> the sentence CANNOT mention renewal",
  !/renew/i.test(textOf({})), textOf({}));
ok("applies_to_renewal=true  -> renewal appears",
  /renew/i.test(textOf({ applies_to_renewal: true })));
ok("applies_to_transfer=false -> the sentence CANNOT mention transfer",
  !/transfer/i.test(textOf({})));

// Prose that screams renewal cannot make the renderer say renewal.
const LYING_PROSE = "Per applicant, at move-in AND AT RENEWAL, and on every transfer.";
ok("a CONTRADICTORY applicability_basis cannot change the sentence",
  textOf({ applicability_basis: LYING_PROSE }) === APPROVED,
  textOf({ applicability_basis: LYING_PROSE }));
ok("the contradiction is SURFACED as an operator warning, not acted on",
  !!render({ applicability_basis: LYING_PROSE }).supporting_explanation_warning);
ok("the prose is still carried as supporting explanation",
  render({ applicability_basis: LYING_PROSE }).supporting_explanation === LYING_PROSE);
ok("no warning when prose and structure agree",
  render({}).supporting_explanation_warning === null);

// ── CADENCE / OBLIGATION ─────────────────────────────────────────────
ok("monthly cadence reads 'per month'",
  /\$30 per month per unit/.test(textOf({ display_label: "Pet rent", amount: 30,
    cadence: "monthly", economic_class: "recurring_charge", assessed_per: "unit",
    incurred_on_event: null })),
  textOf({ display_label: "Pet rent", amount: 30, cadence: "monthly",
           economic_class: "recurring_charge", assessed_per: "unit", incurred_on_event: null }));
ok("one-time cadence does NOT say 'per month'", !/per month/.test(textOf({})));
ok("optional obligation is stated as optional",
  /optional/.test(textOf({ obligation: "optional" })));
ok("conditional obligation states its condition in plain words",
  /when resident elects parking/.test(
    textOf({ obligation: "conditional", condition_key: "resident_elects_parking" })),
  textOf({ obligation: "conditional", condition_key: "resident_elects_parking" }));
ok("move-in event adds a natural 'due at move-in'",
  /due at move-in/.test(textOf({ incurred_on_event: "move_in" })), textOf({ incurred_on_event: "move_in" }));
ok("the application event is NOT repeated as a robotic tail",
  !/due at application/.test(textOf({})));

// ── HONEST REFUSALS ──────────────────────────────────────────────────
const reason = (patch) => render(patch).reason;
ok("missing amount -> unquotable, not a sentence", render({ amount: null }).quotable === false);
ok("missing amount names amount_missing", reason({ amount: null }) === "amount_missing");
ok("unresolved amount names amount_unresolved",
  reason({ amount: null, amount_unresolved_reason: "range with no determinant" }) === "amount_unresolved");
ok("MISSING assessed_per -> unquotable (the defect that stopped Slice B)",
  render({ assessed_per: null }).quotable === false);
ok("missing assessed_per names assessment_basis_unresolved",
  reason({ assessed_per: null }) === "assessment_basis_unresolved");
ok("an unknown assessed_per value fails closed, it is not coerced",
  reason({ assessed_per: "per-unit" }) === "assessment_basis_unknown_value");
ok("no lifecycle applicability at all -> applies_to_nothing",
  reason({ applies_to_new_lease: false, applies_to_renewal: false,
           applies_to_transfer: false, incurred_on_event: null }) === "applies_to_nothing");
ok("conditional with no condition_key -> condition_unresolved",
  reason({ obligation: "conditional" }) === "condition_unresolved");
ok("missing cadence -> cadence_unknown", reason({ cadence: null }) === "cadence_unknown");
ok("missing label -> no_display_label", reason({ display_label: "" }) === "no_display_label");

// ── CONTRADICTORY STRUCTURED COMBINATIONS ────────────────────────────
ok("incurred_on_event=renewal while applies_to_renewal=false -> REFUSED",
  reason({ incurred_on_event: "renewal" }) === "contradictory_terms");
ok("incurred_on_event=transfer while applies_to_transfer=false -> REFUSED",
  reason({ incurred_on_event: "transfer" }) === "contradictory_terms");
ok("a refusal NEVER carries text", render({ assessed_per: null }).text === null);
ok("a refusal still carries the prose for an operator to read",
  render({ assessed_per: null }).supporting_explanation === BASE.applicability_basis);

// ── THE SENTENCE IS DERIVED, NEVER STORED ────────────────────────────
const src = require("fs").readFileSync(
  require("path").join(__dirname, "../../src/money/governed_charge_language.js"), "utf8");
ok("the renderer performs no I/O and caches nothing",
  !/require\(["']pg["']\)|client\.query|pool\.|cache|memo/i.test(src));
ok("the renderer never reads applicability_basis to BUILD the sentence",
  !/applicability_basis/.test(src.split("function renderChargeTerms")[1].split("return {")[0]));
ok("derived_from exposes the structured terms the sentence came from",
  render({}).derived_from.assessed_per === "applicant"
  && render({}).derived_from.applies_to_renewal === false);

// ── THE SHAPED READ MUST BE RENDERABLE ───────────────────────────────
// Found the hard way: governedCharges.shape() collapsed the three booleans
// into an `applies_to` array and dropped them. Feeding a SHAPED charge to the
// renderer produced "applies_to_nothing" and refused to quote a live term,
// while this harness stayed green because it fed raw rows. Every field the
// renderer reads must survive the shaping layer.
const { governedCharges } = require("../../src/money/governed_charges");
const SHAPE_FIELDS = ["display_label", "amount", "currency", "cadence", "obligation",
  "assessed_per", "applies_to_new_lease", "applies_to_renewal", "applies_to_transfer",
  "incurred_on_event", "condition_key", "applicability_basis"];
const shapeSrc = require("fs").readFileSync(
  require("path").join(__dirname, "../../src/money/governed_charges.js"), "utf8");
const shapeBody = shapeSrc.split("const shape = (c) => ({")[1].split("});")[0];
for (const f of SHAPE_FIELDS) {
  ok(`shaped read exposes ${f} (the renderer needs it)`,
    new RegExp(`(^|\\s)${f}:`, "m").test(shapeBody),
    `${f} is missing from governedCharges.shape(), so a shaped charge cannot render`);
}

console.log("\ngoverned_charge_language_proof");
console.log(lines.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed  (${passed + failed} assertions)\n`);
process.exit(failed ? 1 : 0);
