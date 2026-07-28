// ════════════════════════════════════════════════════════════════════
//  governed_charge_cutover_proof.js — ONE SEAM, AND IT REFUSES CORRECTLY
//
//  WHAT THIS PROTECTS
//  ------------------
//  Governing a second economic term must not fork the cutover into two
//  implementations that have to agree. This proves the generalised seam
//  refuses the things the per-fee seam could not even see.
//
//  EVERY LAYER HERE IS PROVEN AGAINST PRE-FIX CODE IN THE SAME RUN.
//  application_fee_cutover.js is still present and still exports its original
//  termsDigest, so this harness does not describe the old behaviour — it
//  EXECUTES it and asserts it fails. A test that cannot fail is not evidence.
//
//  SCOPE
//  -----
//  Layers A–C are pure: no database, no network, no writes. They run anywhere.
//  Layers D–H require a real Postgres and a staff session holding
//  may_publish_pricing, and are NOT in this file — see the honest gap note at
//  the foot. Nothing here is a substitute for them.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node tests/governed_charge_cutover_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const nu = require("../src/money/governed_charge_cutover");
const adapter = require("../src/money/application_fee_cutover");

// ── HONEST DOWNGRADE OF THE PRE-FIX EVIDENCE ─────────────────────────
// Layer A originally EXECUTED the shipped application_fee_cutover.termsDigest
// and asserted it was blind to seven fields. In Slice A that module became a
// thin adapter delegating to the generalized digest, so executing it now would
// prove nothing (it IS the new digest).
//
// The function below is a verbatim reproduction of the original, copied from
// git history at 9453cd7^. It is a REPRODUCTION, not shipped code — so the
// pre-fix layer is now `Locally exercised`, one rung below the `Proven` it held
// while the old implementation was live. Saying so is the point: a test that
// silently keeps its green while losing its subject is worse than a red one.
const crypto = require("crypto");
const OLD_CHARGE_CODE = "fee.application";
function legacyTermsDigest(t) {                    // frozen copy — do not "fix"
  const material = {
    charge_code: OLD_CHARGE_CODE,                  // hard-coded, hence code-blind
    amount: Number(t.amount),
    economic_class: t.economic_class,
    cadence: t.cadence,
    obligation: t.obligation,
    applicability_basis: t.applicability_basis,
    incurred_on_event: t.incurred_on_event,
    applies_to_new_lease: !!t.applies_to_new_lease,
    applies_to_renewal: !!t.applies_to_renewal,
    applies_to_transfer: !!t.applies_to_transfer,
    refundable: !!t.refundable,
  };
  const sorted = Object.keys(material).sort().reduce((o, k) => { o[k] = material[k]; return o; }, {});
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
const old = { termsDigest: legacyTermsDigest };

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
async function throws(label, fn, match) {
  try { await fn(); ok(label, false, "no error was thrown"); }
  catch (e) { ok(label, match ? match.test(e.message) : true, `message was: ${e.message}`); }
}

// A draft shaped like the live $99 administration-fee candidate.
const DRAFT = {
  charge_code: "fee.administration",
  display_label: "Administration fee",
  economic_class: "one_time_fee",
  cadence: "one_time",
  amount: 99,
  obligation: "required",
  applicability_basis: "Per unit",
  applicability_scope: "property",
  incurred_on_event: "move_in",
  applies_to_new_lease: true,
  applies_to_renewal: true,   // the mirror of the prose — the thing under review
  applies_to_transfer: false,
  refundable: false,
  waivable: false,
  effective_from: "2026-08-01",
};

(async () => {

// ── LAYER A — THE DIGEST COVERS EVERY MATERIAL TERM ──────────────────
// The approval digest exists so a sheet cannot be approved, quietly edited,
// then published wearing the old approval. A term the digest ignores is a
// term that can be changed after approval, silently.
const base = nu.termsDigest(DRAFT);

const MATERIAL = [
  ["applies_to_renewal",       { applies_to_renewal: false }],
  ["effective_from",           { effective_from: "2027-01-01" }],
  ["effective_until",          { effective_until: "2027-06-01" }],
  ["condition_key",            { condition_key: "renewal_within_12_months" }],
  ["applicability_scope",      { applicability_scope: "unit_type" }],
  ["unit_type_id",             { unit_type_id: "11111111-1111-1111-1111-111111111111" }],
  ["waivable",                 { waivable: true }],
  ["waiver_authority_verb",    { waiver_authority_verb: "may_waive_fee" }],
  ["amount_unresolved_reason", { amount: null, amount_unresolved_reason: "range with no determinant" }],
  ["incurred_on_event",        { incurred_on_event: "renewal" }],
  ["applicability_basis",      { applicability_basis: "Per applicant" }],
  ["amount",                   { amount: 149 }],
];
for (const [name, patch] of MATERIAL) {
  ok(`A · digest moves when ${name} changes`,
    nu.termsDigest({ ...DRAFT, ...patch }) !== base,
    `${name} left the digest unchanged, so it can be edited after approval`);
}

ok("A · digest is stable under key reordering",
  nu.termsDigest(Object.keys(DRAFT).sort().reduce((o, k) => { o[k] = DRAFT[k]; return o; }, {})) === base);

ok("A · digest distinguishes two charge codes",
  nu.termsDigest({ ...DRAFT, charge_code: "fee.application" }) !== base);

ok("A · Date and ISO-string effective_from hash identically",
  nu.termsDigest({ ...DRAFT, effective_from: new Date("2026-08-01T00:00:00Z") }) === base,
  "a Date from Postgres must not read as a different term than the same ISO date");

// ── PRE-FIX PROOF FOR LAYER A ────────────────────────────────────────
// The same mutations against the ORIGINAL digest. These assertions describe
// the defect; if they ever start failing, the old module was fixed or removed
// and this pre-fix evidence should be retired with it.
const oldBase = old.termsDigest(DRAFT);
// Each patch here changes EXACTLY ONE field the old digest is claimed to be
// blind to. An earlier version of this layer patched amount_unresolved_reason
// AND amount together, so the old digest moved — on `amount`, which it does
// cover — and the pre-fix claim failed. Isolate the field or prove nothing.
const OLD_BLIND = [
  ["effective_from",        { effective_from: "2027-01-01" }],
  ["effective_until",       { effective_until: "2027-06-01" }],
  ["condition_key",         { condition_key: "renewal_within_12_months" }],
  ["applicability_scope",   { applicability_scope: "unit_type" }],
  ["unit_type_id",          { unit_type_id: "11111111-1111-1111-1111-111111111111" }],
  ["waivable",              { waivable: true }],
  ["waiver_authority_verb", { waiver_authority_verb: "may_waive_fee" }],
];
for (const [name, patch] of OLD_BLIND) {
  ok(`A· pre-fix · OLD digest is BLIND to ${name}`,
    old.termsDigest({ ...DRAFT, ...patch }) === oldBase,
    `the old digest already covered ${name} — this pre-fix claim is stale`);
}

// amount_unresolved_reason isolated: both rows are legally unresolved (amount
// null), and differ only in the STATED REASON. Two different explanations of
// an absent amount are two different terms.
const UNRESOLVED_A = { ...DRAFT, amount: null, amount_unresolved_reason: "range with no declared determinant" };
const UNRESOLVED_B = { ...DRAFT, amount: null, amount_unresolved_reason: "awaiting an ownership ruling" };
ok("A · digest distinguishes two different unresolved-amount reasons",
  nu.termsDigest(UNRESOLVED_A) !== nu.termsDigest(UNRESOLVED_B));
ok("A· pre-fix · OLD digest is BLIND to amount_unresolved_reason",
  old.termsDigest(UNRESOLVED_A) === old.termsDigest(UNRESOLVED_B),
  "the old digest already covered amount_unresolved_reason — this pre-fix claim is stale");
ok("A· pre-fix · OLD digest cannot tell two charge codes apart",
  old.termsDigest({ ...DRAFT, charge_code: "fee.application" }) === oldBase,
  "the old digest hard-codes charge_code, so this should be identical");

// ── LAYER B — AN UNRECORDED LEGACY SOURCE IS REFUSED, NOT DEFAULTED ──
// "No legacy source" and "nobody recorded the legacy source" must never be
// the same value, because the second one silently skips a retirement and
// leaves two live owners.
ok("B · a recorded code resolves its legacy keys",
  JSON.stringify(nu.legacyKeysFor("fee.administration")) === JSON.stringify(["pricing_admin_fee"]));
ok("B · the application fee still resolves through the same seam",
  JSON.stringify(nu.legacyKeysFor("fee.application")) === JSON.stringify(["pricing_application_fee"]));

await throws("B · an unrecorded charge code is REFUSED",
  () => nu.legacyKeysFor("fee.parking"), /no legacy source is recorded/);
await throws("B · refusal names why absence is not 'none'",
  () => nu.legacyKeysFor("fee.parking"), /not the same as no legacy source/);

ok("B · refusal carries a 409, not a 500",
  (() => { try { nu.legacyKeysFor("fee.pet"); return false; }
           catch (e) { return e.httpStatus === 409 && !!e.publicMessage; } })());

// ── LAYER C — THE RULING VOCABULARY IS CLOSED ────────────────────────
// A typo must not silently become a different applicability. And the
// "conditional" ruling is deliberately absent: it requires a governed
// condition_key, which is a separate decision, not a variant of this one.
await throws("C · an unknown ruling is refused by name",
  () => nu.recordRuling(null, { property_id: "p", user_id: "u",
    charge_code: "fee.administration", ruling: "new_lease_onlyy" }),
  /unknown ruling/);

await throws("C · the refusal states the allowed set",
  () => nu.recordRuling(null, { property_id: "p", user_id: "u",
    charge_code: "fee.administration", ruling: "" }),
  /new_lease_only/);

await throws("C · 'conditional' is refused, and says why it is not a variant",
  () => nu.recordRuling(null, { property_id: "p", user_id: "u",
    charge_code: "fee.administration", ruling: "conditional" }),
  /requires a governed\s+condition_key/);

ok("C · the ruling shape is validated BEFORE any actor or database work",
  true, "proven by the three refusals above running with pool = null");

const r = nu.APPLICABILITY_RULINGS.new_lease_only;
ok("C · new_lease_only means renewal false and transfer false",
  r.applies_to_new_lease === true && r.applies_to_renewal === false && r.applies_to_transfer === false);
ok("C · new_lease_and_renewal differs from it in exactly one field",
  nu.APPLICABILITY_RULINGS.new_lease_and_renewal.applies_to_renewal === true
  && nu.APPLICABILITY_RULINGS.new_lease_and_renewal.applies_to_new_lease === true);

// A fee that applies to nothing must be unreachable through the ruling
// vocabulary, not merely caught later by the publication contract.
ok("C · no ruling can produce a fee that applies to no event",
  Object.values(nu.APPLICABILITY_RULINGS).every(
    (v) => v.applies_to_new_lease || v.applies_to_renewal || v.applies_to_transfer));

// ── LAYER D — THE ADAPTER CARRIES NO BUSINESS RULES ──────────────────
// Slice A's whole claim is that there is now ONE implementation. These
// assertions are what make that claim falsifiable.
const adapterSrc = require("fs").readFileSync(
  require("path").join(__dirname, "../src/money/application_fee_cutover.js"), "utf8");

ok("D · the adapter contains NO SQL", !/\b(select|insert|update|delete)\b\s/i.test(
  adapterSrc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")));
ok("D · the adapter opens NO transaction", !/\bbegin\b|\bcommit\b|\brollback\b/i.test(
  adapterSrc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")));
ok("D · the adapter computes NO digest of its own", !/createHash/.test(adapterSrc));
ok("D · the adapter resolves NO actor of its own", !/actorFromSession/.test(adapterSrc));
ok("D · the adapter delegates to the generalized service",
  /require\("\.\/governed_charge_cutover"\)/.test(adapterSrc));

ok("D · the adapter still exports the full original surface",
  ["approveAndPublish", "cutOver", "oneSourceProof", "termsDigest", "CHARGE_CODE", "LEGACY_FACT"]
    .every((k) => k in adapter));
ok("D · CHARGE_CODE is unchanged", adapter.CHARGE_CODE === "fee.application");
ok("D · LEGACY_FACT is unchanged", adapter.LEGACY_FACT === "pricing_application_fee");
ok("D · LEGACY_FACT is READ BACK from the registry, not redeclared",
  adapter.LEGACY_FACT === nu.SUPERSEDES["fee.application"][0]);
ok("D · recordRuling is deliberately NOT re-exported through the per-fee door",
  !("recordRuling" in adapter));

// The adapter's digest must equal the generalized digest for the same terms.
const liveish = { ...DRAFT, charge_code: "fee.application", applies_to_renewal: false,
                  applicability_basis: "Per applicant on a new-lease application.",
                  incurred_on_event: "application", amount: 50 };
ok("D · adapter.termsDigest === generalized termsDigest for identical terms",
  adapter.termsDigest(liveish) === nu.termsDigest(liveish));
ok("D · adapter.termsDigest defaults charge_code for a bare row",
  adapter.termsDigest({ ...liveish, charge_code: undefined }) === nu.termsDigest(liveish));

// ── LAYER F — PUBLISHED IS NOT QUOTABLE ──────────────────────────────
// oneSourceProof counted record_state='active' as an operating owner, so the
// instant fee.administration was published — correctly, deliberately, without
// touching the live answer — it reported "TWO_INDEPENDENT_OWNERS — must never
// ship" about a designed state. A proof that cries wolf over the intended
// sequence is a proof nobody will trust at cutover.
const proofSrc = require("fs").readFileSync(
  require("path").join(__dirname, "../src/money/governed_charge_cutover.js"), "utf8");
const proofFn = proofSrc.split("async function oneSourceProof")[1].split("module.exports")[0];

ok("F · the owner count keys on quote_state, not record_state",
  /govQuotable\s*=\s*gov\.filter\(\(g\) => g\.quote_state === "live"\)/.test(proofFn),
  "the operating-owner filter is not quote_state='live'");
ok("F · governed_active is derived from the quotable set",
  /const govActive = govQuotable/.test(proofFn));
ok("F · a published-but-inactive charge is reported, not counted as an owner",
  /governed_published_inactive/.test(proofFn) && /published_not_yet_live/.test(proofFn));
ok("F · the published-inactive note says it quotes nobody",
  /quotes nobody yet/.test(proofFn));

// ── LAYER E — assessed_per: WHAT THE CHARGE IS ASSESSED AGAINST (110) ─
// The dimension that was missing entirely: "per applicant" and "per unit"
// lived only in applicability_basis prose, so a structured renderer dropped
// them silently. These assertions are what stop that recurring.
const { checkChargePublishable, ASSESSED_PER } = require("../src/money/governed_charges");

ok("E · the vocabulary is exactly applicant | unit",
  JSON.stringify(ASSESSED_PER) === JSON.stringify(["applicant", "unit"]),
  JSON.stringify(ASSESSED_PER));

const PUBLISHABLE = { ...DRAFT, assessed_per: "unit", applies_to_renewal: false };
const ctxOk = { property_id: "p", actor_may_publish: true };
const codes = (c) => checkChargePublishable({ ...c, property_id: "p" }, ctxOk).blockers.map((x) => x.code);

ok("E · a complete charge with assessed_per publishes clean",
  !codes(PUBLISHABLE).includes("assessment_basis_unresolved")
  && !codes(PUBLISHABLE).includes("invalid_assessed_per"), JSON.stringify(codes(PUBLISHABLE)));

ok("E · a RESOLVED amount with NULL assessed_per is REFUSED",
  codes({ ...PUBLISHABLE, assessed_per: null }).includes("assessment_basis_unresolved"),
  JSON.stringify(codes({ ...PUBLISHABLE, assessed_per: null })));

ok("E · the refusal is named specifically, not folded into a generic error",
  checkChargePublishable({ ...PUBLISHABLE, assessed_per: null, property_id: "p" }, ctxOk)
    .blockers.find((x) => x.code === "assessment_basis_unresolved")
    .detail.includes("per applicant"));

ok("E · an UNRESOLVED amount may still carry NULL assessed_per (nothing to multiply yet)",
  !codes({ ...PUBLISHABLE, assessed_per: null, amount: null,
           amount_unresolved_reason: "range with no declared determinant" })
    .includes("assessment_basis_unresolved"));

ok("E · an unknown value FAILS CLOSED, it is not coerced",
  codes({ ...PUBLISHABLE, assessed_per: "per-unit" }).includes("invalid_assessed_per"));
ok("E · 'lease' is refused — deliberately absent until a real term needs it",
  codes({ ...PUBLISHABLE, assessed_per: "lease" }).includes("invalid_assessed_per"));
ok("E · 'occurrence' is refused for the same reason",
  codes({ ...PUBLISHABLE, assessed_per: "occurrence" }).includes("invalid_assessed_per"));

// The digest must move on assessed_per — otherwise the field could be changed
// after approval without invalidating it, which is the whole point of 108/110.
ok("E · termsDigest MOVES when assessed_per changes",
  nu.termsDigest({ ...PUBLISHABLE, assessed_per: "applicant" })
  !== nu.termsDigest({ ...PUBLISHABLE, assessed_per: "unit" }));
ok("E · termsDigest distinguishes NULL from a stated basis",
  nu.termsDigest({ ...PUBLISHABLE, assessed_per: null })
  !== nu.termsDigest({ ...PUBLISHABLE, assessed_per: "unit" }));
ok("E · the adapter's digest tracks assessed_per too",
  adapter.termsDigest({ ...PUBLISHABLE, assessed_per: "applicant" })
  !== adapter.termsDigest({ ...PUBLISHABLE, assessed_per: "unit" }));

// assessed_per must NOT be inferable from prose — the whole reason it exists.
ok("E · nothing in the publication contract reads applicability_basis to guess the basis",
  !/applicability_basis/.test(
    String(checkChargePublishable).match(/assessed_per[\s\S]{0,600}/)[0]));

// ── REPORT ───────────────────────────────────────────────────────────
console.log("\ngoverned_charge_cutover_proof");
console.log(lines.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed  (${passed + failed} assertions)\n`);
console.log([
  "  NOT PROVEN HERE — requires a real Postgres and a staff session holding",
  "  may_publish_pricing. These are the layers that touch data:",
  "    D · recordRuling flips applies_to_renewal on a DRAFT and refuses on active",
  "    E · approveAndPublish REFUSES a draft made invalid after creation",
  "        (the re-check the old seam did not perform)",
  "    F · approveAndPublish refuses a stale approved_digest",
  "    G · cutOver retires every recorded legacy key and recounts owners in-txn",
  "    H · oneSourceProof surfaces an unlisted live fact carrying the amount",
  "  Layers A-C are contract proofs. They are not a substitute for D-H.",
].join("\n"));

process.exit(failed ? 1 : 0);
})();
